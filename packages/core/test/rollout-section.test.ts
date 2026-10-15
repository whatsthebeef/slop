import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { InvestigationService } from '../src/app/investigation-service.js';
import { CAPABILITY_NAMES } from '../src/domain/capabilities.js';
import { PREDICTED_ROLLOUT_TITLE } from '../src/domain/human-steps.js';
import type { Result } from '../src/domain/errors.js';
import { ROLLOUT_NONE_LABEL, ROLLOUT_NOT_WRITTEN_TITLE, checkRolloutAnswer, parseRollout, rolloutScriptLabel, touchesRolloutPaths } from '../src/domain/rollout.js';
import { DEFAULT_ROLLOUT_PATHS } from '../src/domain/merge-policy.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const record = (rollout: string): string => `# Implementation\n\nDid things.\n\n${rollout}\n\n## Checks\n\n- vitest passed\n`;

const FENCE = '```';

/** The placeholder step the old path flag wrote ("Rollout steps not written"), seeded straight into the store. */
const legacyFlag = async (store: MemoryStore, glob: Glob): Promise<void> => {
  await store.transaction((tx) =>
    tx.saveHumanSteps([
      {
        id: `hs_legacy_${glob.id}`,
        boardId: glob.boardId,
        globId: glob.id,
        kind: 'rollout',
        title: ROLLOUT_NOT_WRITTEN_TITLE,
        detail: null,
        who: 'anyone',
        due: 'after_merge',
        state: 'open',
        blocks: ['sign_off', 'dependants'],
        check: null,
        script: null,
        origin: 'rollout-paths',
        createdBy: 'slop',
        createdAt: '2026-10-13T12:00:00.000Z',
        doneBy: null,
        doneAt: null,
        dismissedReason: null,
      },
    ]),
  );
};

describe('parseRollout', () => {
  it('reads script, setting and manual steps with their detail, checks and the script body', () => {
    const steps = parseRollout(
      record(`## Rollout
- script: Deploy the host stack (check: fileAttachments)
  Run it from a laptop with the deploy role.
  ${FENCE}bash
  infra/deploy/host-deploy.sh
  ${FENCE}
- setting: Add ATTACHMENTS_BUCKET to /slop/prod/server-env check: attachmentEvents
- Manual: Turn on the network setting in the Claude app
`),
    );
    expect(steps).toEqual([
      { kind: 'script', title: 'Deploy the host stack', detail: 'Run it from a laptop with the deploy role.', check: 'fileAttachments', script: 'infra/deploy/host-deploy.sh', scriptPath: null },
      { kind: 'setting', title: 'Add ATTACHMENTS_BUCKET to /slop/prod/server-env', detail: null, check: 'attachmentEvents', script: null, scriptPath: null },
      { kind: 'manual', title: 'Turn on the network setting in the Claude app', detail: null, check: null, script: null, scriptPath: null },
    ]);
  });

  it('keeps a multi-line script as written and a second block in the detail', () => {
    const [step] = parseRollout(
      record(`## Rollout
- script: Backfill
${FENCE}sh
set -e
  indented
${FENCE}
  Then this:
  ${FENCE}
  select 1;
  ${FENCE}
`),
    );
    expect(step?.script).toBe('set -e\n  indented');
    expect(step?.detail).toContain('Then this:');
    expect(step?.detail).toContain('select 1;');
  });

  it("keeps a step's Why / Do this / Check it worked bullets as its detail, in order, with their code block", () => {
    const [step] = parseRollout(
      record(`## Rollout
- manual: Approve s14k3 on the pocketlab-notebook board
  - **Why:** the board needs the sub-gate rule.
  - **Do this:** open the board's Knowledge page, then run:
    ${FENCE}bash
    echo ok
    ${FENCE}
  - **Check it worked:** the item shows Approved.
`),
    );
    expect(step?.title).toBe('Approve s14k3 on the pocketlab-notebook board');
    expect(step?.detail).toBe(
      ['- **Why:** the board needs the sub-gate rule.', "- **Do this:** open the board's Knowledge page, then run:", `${FENCE}bash`, 'echo ok', FENCE, '- **Check it worked:** the item shows Approved.'].join('\n'),
    );
  });

  it('cuts a title over 120 characters at its first sentence and moves the rest into the detail', () => {
    const long = 'Add the setting to the boards still on sub-gate.yml before updating. Blocks that board, not this sign-off. Ask an admin to approve the KB item first so the workflow is found.';
    const [step] = parseRollout(`## Rollout\n- setting: ${long}\n  - **Why:** because.\n`);
    expect(step?.title).toBe('Add the setting to the boards still on sub-gate.yml before updating');
    expect(step?.detail).toBe('Blocks that board, not this sign-off. Ask an admin to approve the KB item first so the workflow is found.\n- **Why:** because.');
    const words = 'word '.repeat(40).trim();
    const [word] = parseRollout(`## Rollout\n- manual: ${words}\n`);
    expect(word?.title.length).toBeLessThanOrEqual(120);
    expect(word?.title.endsWith('…')).toBe(true);
    expect(word?.detail).toBe(words);
  });

  it("points a step at a repo script with a `script: path` line, which isn't shown as detail and wins over a fenced body", () => {
    const [step, bold] = parseRollout(
      record(`## Rollout
- script: Protect the main branch
  - **Why:** slop needs the ruleset.
  - script: \`scripts/rollout/s15t170-ruleset.sh\`
  - **Do this:** run:
    ${FENCE}bash
    bash scripts/rollout/s15t170-ruleset.sh
    ${FENCE}
- script: Second
  - **Script:** catalog/scripts/setup-repo.sh
`),
    );
    expect(step?.scriptPath).toBe('scripts/rollout/s15t170-ruleset.sh');
    expect(step?.script).toBeNull();
    expect(step?.detail).not.toContain('s15t170-ruleset.sh`');
    expect(step?.detail).toContain('**Do this:** run:');
    expect(bold?.scriptPath).toBe('catalog/scripts/setup-repo.sh');
  });

  it('ignores a script line whose path is absolute, climbs out of the repo or has spaces', () => {
    for (const path of ['/etc/passwd', '../x.sh', 'a/../../x.sh', 'a b.sh']) {
      const [step] = parseRollout(`## Rollout\n- script: Run it\n  - script: ${path}\n`);
      expect(step?.scriptPath).toBeNull();
    }
  });

  it('treats an item with no kind as manual, and stops at the next heading of the same level', () => {
    const steps = parseRollout('## Rollout\n- Ask the PO to enable it\n\n### Details\n- not a step either way\n\n## Next\n- nope\n');
    expect(steps.map((s) => [s.kind, s.title])).toEqual([
      ['manual', 'Ask the PO to enable it'],
      ['manual', 'not a step either way'],
    ]);
  });

  it('reads bullets nested under a step as its detail, not as steps', () => {
    const steps = parseRollout('## Rollout\n- script: Deploy\n  - run it\n  - then wait\n- manual: Tell the team\n    * in the channel\n- setting: Last\n');
    expect(steps.map((s) => [s.kind, s.title, s.detail])).toEqual([
      ['script', 'Deploy', '- run it\n- then wait'],
      ['manual', 'Tell the team', '* in the channel'],
      ['setting', 'Last', null],
    ]);
  });

  it('reads numbered items as steps, and keeps a step list indented as a whole', () => {
    expect(parseRollout('## Rollout\n1. setting: Add the var\n2) Redeploy\n').map((s) => [s.kind, s.title])).toEqual([
      ['setting', 'Add the var'],
      ['manual', 'Redeploy'],
    ]);
    expect(parseRollout('## Rollout\n  - manual: A\n  - manual: B\n    - nested\n').map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('ignores a Rollout heading or a stray heading inside a code fence', () => {
    expect(parseRollout(`${FENCE}md\n## Rollout\n- manual: Not real\n${FENCE}\n`)).toEqual([]);
    const steps = parseRollout(`## Rollout\n- script: Run\n${FENCE}\n## not a heading\n${FENCE}\n- manual: After\n`);
    expect(steps.map((s) => s.title)).toEqual(['Run', 'After']);
    expect(steps[0]?.script).toBe('## not a heading');
  });

  it.each(['None', 'n/a', 'N/A.', 'Nothing', '- None', '- n/a'])('has no steps when the section says %s', (text) => {
    expect(parseRollout(record(`## Rollout\n\n${text}\n`))).toEqual([]);
  });

  it('has no steps without the section, with it empty, or with prose only', () => {
    expect(parseRollout('# Record\n\nNothing about rollout here.\n')).toEqual([]);
    expect(parseRollout('## Rollout\n')).toEqual([]);
    expect(parseRollout('## Rollout\n\nThe image deploy is all this needs.\n')).toEqual([]);
  });

  it('keeps a step whose check is not a capability, with check null and a note in the detail', () => {
    const [step] = parseRollout('## Rollout\n- setting: Set the thing (check: telepathy)\n');
    expect(step).toEqual({ kind: 'setting', title: 'Set the thing', detail: 'check: telepathy is not a capability slop knows', check: null, script: null, scriptPath: null });
  });

  it('makes titles unique and gives a script with no title a name', () => {
    const steps = parseRollout('## Rollout\n- manual: Same\n- manual: Same\n- script:\n');
    expect(steps.map((s) => s.title)).toEqual(['Same', 'Same (2)', 'Run the script']);
  });

  it('labels a script by its title, stably', () => {
    expect(rolloutScriptLabel('Deploy the host stack!')).toBe('rollout: deploy-the-host-stack');
    expect(rolloutScriptLabel('Deploy the host stack!')).toBe(rolloutScriptLabel('Deploy the host stack!'));
  });

  it('knows the capability names the parser accepts', () => {
    for (const name of CAPABILITY_NAMES) expect(parseRollout(`## Rollout\n- manual: x (check: ${name})\n`)[0]?.check).toBe(name);
  });
});

describe('touchesRolloutPaths', () => {
  it('matches the default paths and nothing else', () => {
    expect(touchesRolloutPaths(['infra/stacks/host.ts'], DEFAULT_ROLLOUT_PATHS)).toBe(true);
    expect(touchesRolloutPaths(['apps/server/src/config.ts'], DEFAULT_ROLLOUT_PATHS)).toBe(true);
    // Workflows deploy with the merge and migrations run on start, so neither is a default path.
    expect(touchesRolloutPaths(['.github/workflows/checks.yml'], DEFAULT_ROLLOUT_PATHS)).toBe(false);
    expect(touchesRolloutPaths(['apps/server/drizzle/0060_x.sql'], DEFAULT_ROLLOUT_PATHS)).toBe(false);
    expect(touchesRolloutPaths(['apps/server/src/main.ts', 'README.md'], DEFAULT_ROLLOUT_PATHS)).toBe(false);
    expect(touchesRolloutPaths([], DEFAULT_ROLLOUT_PATHS)).toBe(false);
    expect(touchesRolloutPaths(['a.ts'], [' '])).toBe(false);
  });
});

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

describe('the implementation record becomes rollout steps', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;
  let notifier: RecordingNotifier;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Ship it',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const update = async (id: string, patch: Partial<Glob>): Promise<Glob> =>
    store.transaction(async (tx) => {
      const current = (await tx.getGlob(id)) as Glob;
      const next = { ...current, ...patch, version: current.version + 1 };
      await tx.updateGlob(next, current.version);
      return next;
    });
  const newGlob = async (patch: Partial<Glob> = {}): Promise<Glob> => {
    const created = unwrap(await globs.create(DEV, input()));
    return Object.keys(patch).length === 0 ? created : update(created.id, patch);
  };
  const merge = (id: string) => update(id, { status: 'reviewing', labels: { CR: 'required' }, pr: { number: 1, state: 'merged', headSha: 'abc1234' } });
  const put = async (id: string, text: string) =>
    unwrap(await artifacts.putArtifact(DEV, id, 'implementation_plan', text, { commitSha: 'abc1234', runId: null, agentSetVersion: 3 }));
  const stepsOf = (id: string) => [...store.state.humanSteps.values()].filter((s) => s.globId === id);
  const events = (change: string) => store.state.events.filter((e) => e.type === 'HumanStepChanged' && e.data.change === change);

  const ROLLOUT = `## Rollout
- script: Deploy the host stack (check: fileAttachments)
  ${FENCE}bash
  infra/deploy/host-deploy.sh
  ${FENCE}
- setting: Add ATTACHMENTS_BUCKET to /slop/prod/server-env
`;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-13T12:00:00.000Z' };
    runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const investigation = new InvestigationService({
      store,
      clock,
      notifier,
      escalate: (email, id, i) => globs.escalateToSame(email, id, i),
      predictRollout: (id) => globs.predictRollout(id),
    });
    artifacts = new ArtifactService({ store, clock, notifier, investigation, rollout: (email, id, text, source) => globs.reconcileRollout(email, id, text, source) });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('stores the record\'s steps as rollout steps after the merge that block sign-off and dependants, with the script as an artifact', async () => {
    const g = await newGlob();
    await put(g.id, record(ROLLOUT));
    expect(stepsOf(g.id).map((s) => ({ kind: s.kind, title: s.title, origin: s.origin, due: s.due, blocks: s.blocks, who: s.who, check: s.check, script: s.script }))).toEqual([
      { kind: 'rollout', title: 'Deploy the host stack', origin: 'rollout-section', due: 'after_merge', blocks: ['sign_off', 'dependants'], who: 'anyone', check: 'fileAttachments', script: { artifact: 'rollout: deploy-the-host-stack' } },
      { kind: 'rollout', title: 'Add ATTACHMENTS_BUCKET to /slop/prod/server-env', origin: 'rollout-section', due: 'after_merge', blocks: ['sign_off', 'dependants'], who: 'anyone', check: null, script: null },
    ]);
    const script = unwrap(await artifacts.artifact(DEV, g.id, 'rollout_script', 'rollout: deploy-the-host-stack'));
    expect(script.content).toBe('infra/deploy/host-deploy.sh');
    expect(events('added')).toHaveLength(2);
    expect(notifier.hints.map((h) => h.kind)).toContain('glob.changed');
  });

  it('stores a step that names a repo script with the path as its script, and no artifact', async () => {
    const g = await newGlob();
    await put(g.id, record('## Rollout\n- script: Protect the branch\n  - script: scripts/rollout/x-ruleset.sh\n  - **Do this:** run it\n'));
    expect(stepsOf(g.id).map((s) => s.script)).toEqual([{ path: 'scripts/rollout/x-ruleset.sh' }]);
    expect(unwrap(await artifacts.versions(DEV, g.id, 'rollout_script', 'rollout: protect-the-branch'))).toHaveLength(0);
  });

  it('is idempotent: the same record twice adds no steps, events or script versions', async () => {
    const g = await newGlob();
    await put(g.id, record(ROLLOUT));
    await put(g.id, record(ROLLOUT));
    expect(stepsOf(g.id)).toHaveLength(2);
    expect(events('added')).toHaveLength(2);
    expect(events('updated')).toHaveLength(0);
    expect(unwrap(await artifacts.versions(DEV, g.id, 'rollout_script', 'rollout: deploy-the-host-stack'))).toHaveLength(1);
  });

  it('replaces the investigator\'s placeholder when real steps arrive', async () => {
    const g = await newGlob();
    await globs.predictRollout(g.id);
    await put(g.id, record(ROLLOUT));
    const placeholder = stepsOf(g.id).find((s) => s.origin === 'investigation');
    expect(placeholder).toMatchObject({ state: 'dismissed', dismissedReason: 'Replaced by the steps in the implementation record' });
    expect(stepsOf(g.id).filter((s) => s.state === 'open')).toHaveLength(2);
  });

  it.each([
    ['an empty section', '## Rollout\n\nNone\n'],
    ['no section', '# Record\n\nNothing about rollout.\n'],
  ])('dismisses the placeholder when a record pushed for a commit has %s', async (_name, text) => {
    const g = await newGlob();
    await merge(g.id);
    await globs.predictRollout(g.id);
    await put(g.id, record(text));
    expect(stepsOf(g.id).map((s) => [s.title, s.state, s.dismissedReason])).toEqual([[PREDICTED_ROLLOUT_TITLE, 'dismissed', 'The implementation record needs no rollout']]);
    expect(unwrap(await globs.get(DEV, g.id)).humanSteps.filter((s) => s.state === 'due')).toEqual([]);
  });

  it('keeps the placeholder while there is no record, or only the one started before any commit', async () => {
    const g = await newGlob();
    await globs.predictRollout(g.id);
    expect(stepsOf(g.id).map((s) => s.state)).toEqual(['open']);
    unwrap(await artifacts.putArtifact(DEV, g.id, 'implementation_plan', '# Implementation record\n\n## Approach\nTBD\n', { commitSha: null, runId: null, agentSetVersion: 3 }));
    expect(stepsOf(g.id).map((s) => s.state)).toEqual(['open']);
  });

  it('keeps done and dismissed steps, replaces open ones that changed, and dismisses open ones that are gone', async () => {
    const g = await newGlob();
    await put(g.id, record(`${ROLLOUT}- manual: Tell the team\n`));
    const byTitle = (t: string) => stepsOf(g.id).find((s) => s.title === t);
    unwrap(await globs.completeHumanStep(DEV, g.id, byTitle('Deploy the host stack')?.id ?? '', null));
    unwrap(await globs.dismissHumanStep(DEV, g.id, byTitle('Tell the team')?.id ?? '', 'Done in chat', null));
    await put(g.id, record('## Rollout\n- script: Deploy the host stack (check: fileAttachments)\n- manual: Tell the team\n- manual: Brand new step\n'));
    expect(byTitle('Deploy the host stack')).toMatchObject({ state: 'done', doneBy: DEV });
    expect(byTitle('Tell the team')?.state).toBe('dismissed');
    expect(byTitle('Brand new step')?.state).toBe('open');
    expect(byTitle('Add ATTACHMENTS_BUCKET to /slop/prod/server-env')).toMatchObject({ state: 'dismissed', dismissedReason: 'No longer in the implementation record' });
    // Changed detail on a still-open step updates it in place.
    const open = byTitle('Brand new step');
    await put(g.id, record('## Rollout\n- manual: Brand new step\n  With some detail.\n'));
    expect(byTitle('Brand new step')).toMatchObject({ id: open?.id, detail: 'With some detail.' });
    expect(events('updated')).toHaveLength(1);
  });

  it('dismisses an open "not written" step when a record with real steps arrives', async () => {
    const g = await newGlob();
    await merge(g.id);
    await legacyFlag(store, g);
    await put(g.id, record(ROLLOUT));
    expect(stepsOf(g.id).find((s) => s.origin === 'rollout-paths')).toMatchObject({ state: 'dismissed', dismissedReason: 'Replaced by the steps in the implementation record' });
    expect(stepsOf(g.id).filter((s) => s.state === 'open')).toHaveLength(2);
  });

  it('adds a new script version when the script changes', async () => {
    const g = await newGlob();
    await put(g.id, record(ROLLOUT));
    await put(g.id, record(ROLLOUT.replace('host-deploy.sh', 'host-deploy.sh --diff')));
    expect(unwrap(await artifacts.versions(DEV, g.id, 'rollout_script', 'rollout: deploy-the-host-stack')).map((a) => a.content)).toEqual([
      'infra/deploy/host-deploy.sh',
      'infra/deploy/host-deploy.sh --diff',
    ]);
  });

  it('works when the glob is already merged: it stays in Reviewing until the steps are done', async () => {
    const g = await newGlob();
    await merge(g.id);
    await put(g.id, record(ROLLOUT));
    expect(unwrap(await globs.get(DEV, g.id)).humanSteps.map((s) => s.state)).toEqual(['due', 'due']);
    expect((await globs.peek(g.id))?.status).toBe('reviewing');
  });

  it('dismissing the last open step because the record dropped it lets an approved merged glob move on', async () => {
    const g = await newGlob();
    await put(g.id, record(ROLLOUT));
    await update(g.id, { status: 'reviewing', labels: { CR: 'approved' }, pr: { number: 1, state: 'merged', headSha: 'abc1234' } });
    await put(g.id, record('## Rollout\n\nNone\n'));
    expect((await globs.peek(g.id))?.status).toBe('signed_off');
  });
});

describe('the rollout job answer', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;

  const create = async (): Promise<Glob> => {
    const created = unwrap(
      await globs.create(DEV, { boardId, title: 'Infra change', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    return store.transaction(async (tx) => {
      const next = { ...created, status: 'reviewing' as const, labels: { CR: 'required' as const }, pr: { number: 1, state: 'merged' as const, headSha: 'abc1234' }, version: created.version + 1 };
      await tx.updateGlob(next, created.version);
      return next;
    });
  };
  const stepsOf = (id: string) => [...store.state.humanSteps.values()].filter((s) => s.globId === id);
  const notes = (id: string) => store.transaction((tx) => tx.artifactVersions(id, 'attachment', ROLLOUT_NONE_LABEL));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-13T12:00:00.000Z' };
    runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService({ store, clock, notifier, rollout: (email, id, text, source) => globs.reconcileRollout(email, id, text, source) });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('is unwritten for a merged glob with no steps, record section or note', async () => {
    const g = await create();
    expect(await globs.rolloutUnwritten(g.id)).toBe(true);
    expect(await globs.rolloutUnwritten('s9t9')).toBe(false);
  });

  it('is not unwritten when the record has a Rollout section, even one whose steps were dismissed', async () => {
    const g = await create();
    unwrap(await artifacts.putArtifact(DEV, g.id, 'implementation_plan', record('## Rollout\n- manual: Do it\n'), { commitSha: null, runId: null, agentSetVersion: null }));
    expect(await globs.rolloutUnwritten(g.id)).toBe(false);
    unwrap(await globs.dismissHumanStep(DEV, g.id, stepsOf(g.id)[0]?.id ?? '', 'Not needed', null));
    expect(await globs.rolloutUnwritten(g.id)).toBe(false);
  });

  it('"none" records the reason on the glob and adds no step for a person', async () => {
    const g = await create();
    expect(await globs.applyRolloutAnswer(g.id, { decision: 'none', reason: 'migration 0071 runs on start; no new settings' }, 'm')).toBe(true);
    expect(stepsOf(g.id)).toEqual([]);
    expect((await notes(g.id)).at(-1)?.content).toContain('No rollout needed: migration 0071 runs on start; no new settings');
    expect(await globs.rolloutUnwritten(g.id)).toBe(false);
    expect(await globs.applyRolloutAnswer(g.id, { decision: 'none', reason: 'again' }, 'm')).toBe(false);
    expect(await notes(g.id)).toHaveLength(1);
  });

  it('"steps" stores the steps after the merge, blocking sign-off, with the script as an artifact; once only', async () => {
    const g = await create();
    const steps = parseRollout('## Rollout\n- script: Deploy the host stack\n```sh\ninfra/deploy/host-deploy.sh\n```\n- setting: Add SLOP_X to the server env\n');
    expect(await globs.applyRolloutAnswer(g.id, { decision: 'steps', steps }, 'm')).toBe(true);
    expect(stepsOf(g.id).map((s) => [s.title, s.kind, s.origin, s.due, s.blocks, s.script])).toEqual([
      ['Deploy the host stack', 'rollout', 'rollout-paths', 'after_merge', ['sign_off', 'dependants'], { artifact: 'rollout: deploy-the-host-stack' }],
      ['Add SLOP_X to the server env', 'rollout', 'rollout-paths', 'after_merge', ['sign_off', 'dependants'], null],
    ]);
    expect(unwrap(await artifacts.artifact(DEV, g.id, 'rollout_script', 'rollout: deploy-the-host-stack')).content).toBe('infra/deploy/host-deploy.sh');
    expect(await globs.applyRolloutAnswer(g.id, { decision: 'steps', steps }, 'm')).toBe(false);
    expect(stepsOf(g.id)).toHaveLength(2);
  });

  it('"ask" adds one step whose title is the specific question', async () => {
    const g = await create();
    await globs.applyRolloutAnswer(g.id, { decision: 'ask', question: 'Does SLOP_X need setting in prod? It has no default' }, 'm');
    expect(stepsOf(g.id)).toHaveLength(1);
    expect(stepsOf(g.id)[0]).toMatchObject({ kind: 'rollout', title: 'Does SLOP_X need setting in prod? It has no default', state: 'open', who: 'anyone' });
  });

  it('replaces the old "not written" step, and lists such globs with their merge commit for the backfill', async () => {
    const g = await create();
    await store.transaction((tx) => tx.appendEvents([{ type: 'Merged', globId: g.id, actor: null, at: '2026-10-13T11:00:00.000Z', data: { sha: 'm1' } }]));
    await legacyFlag(store, g);
    expect(await globs.rolloutUnwritten(g.id)).toBe(true);
    expect(await globs.unwrittenRolloutSteps(boardId)).toEqual([{ globId: g.id, sha: 'm1' }]);
    await globs.applyRolloutAnswer(g.id, { decision: 'none', reason: 'only a comment changed' }, 'm');
    expect(stepsOf(g.id).map((s) => [s.title, s.state])).toEqual([[ROLLOUT_NOT_WRITTEN_TITLE, 'dismissed']]);
    expect(await globs.unwrittenRolloutSteps(boardId)).toEqual([]);
  });

  it('queues the job once for a merge, and not when the rollout is written', async () => {
    const g = await create();
    expect(await globs.queueRolloutWrite(g.id, 'm1')).toBe(true);
    expect(store.state.outboxJobs.filter((j) => j.kind === 'write_rollout_steps' && j.globId === g.id)).toHaveLength(1);
    await globs.applyRolloutAnswer(g.id, { decision: 'none', reason: 'nothing' }, 'm');
    expect(await globs.queueRolloutWrite(g.id, 'm1')).toBe(false);
  });
});

describe('checkRolloutAnswer', () => {
  it('accepts the three decisions', () => {
    expect(checkRolloutAnswer({ decision: 'none', reason: 'No rollout needed: it deploys with the image' })).toEqual({ ok: true, value: { decision: 'none', reason: 'it deploys with the image' } });
    expect(checkRolloutAnswer({ decision: 'ask', question: 'Does X need setting?' })).toEqual({ ok: true, value: { decision: 'ask', question: 'Does X need setting?' } });
    const steps = checkRolloutAnswer({ decision: 'steps', rollout: '- setting: Add X to the env' });
    expect(steps.ok && steps.value.decision === 'steps' && steps.value.steps.map((s) => [s.kind, s.title])).toEqual([['setting', 'Add X to the env']]);
  });

  it.each([null, 'text', [], { decision: 'maybe' }, { decision: 'none' }, { decision: 'ask', question: '  ' }, { decision: 'steps', rollout: 'nothing to do' }])('refuses %j', (answer) => {
    expect(checkRolloutAnswer(answer).ok).toBe(false);
  });
});

describe('steps that tick themselves', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const create = async (patch: Partial<Glob> = {}): Promise<Glob> => {
    const created = unwrap(
      await globs.create(DEV, { boardId, title: 'Attachments', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    return store.transaction(async (tx) => {
      const next = { ...created, ...patch, version: created.version + 1 };
      await tx.updateGlob(next, created.version);
      return next;
    });
  };
  const merged = { status: 'reviewing' as const, labels: { CR: 'approved' as const }, pr: { number: 1, state: 'merged' as const, headSha: 'abc1234' } };
  const step = (id: string) => [...store.state.humanSteps.values()].find((s) => s.globId === id);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-13T12:00:00.000Z' }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('ticks a merged glob\'s step when its capability is on, checked by slop, and the glob moves on', async () => {
    const g = await create(merged);
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Turn on file attachments', check: 'fileAttachments' }));
    expect(await globs.tickCapabilitySteps(boardId, { fileAttachments: false })).toBe(0);
    expect(step(g.id)?.state).toBe('open');
    expect(await globs.tickCapabilitySteps(boardId, { fileAttachments: true })).toBe(1);
    expect(step(g.id)).toMatchObject({ state: 'done', doneBy: 'slop', doneAt: '2026-10-13T12:00:00.000Z' });
    expect(store.state.events.find((e) => e.type === 'HumanStepChanged' && e.data.change === 'done')?.data).toMatchObject({ checked: true, check: 'fileAttachments' });
    expect((await globs.peek(g.id))?.status).toBe('signed_off');
  });

  it('does not tick before the merge, and does after it', async () => {
    const g = await create();
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Turn on file attachments', check: 'fileAttachments' }));
    expect(await globs.tickCapabilitySteps(boardId, { fileAttachments: true })).toBe(0);
    expect(step(g.id)?.state).toBe('open');
    await store.transaction(async (tx) => {
      const current = (await tx.getGlob(g.id)) as Glob;
      await tx.updateGlob({ ...current, ...merged, version: current.version + 1 }, current.version);
    });
    expect(await globs.tickCapabilitySteps(boardId, { fileAttachments: true })).toBe(1);
  });

  it('is idempotent and leaves steps without a check, with another capability, or already closed alone', async () => {
    const g = await create(merged);
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'By hand' }));
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Needs Slack', check: 'slack' }));
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Unknown capability', check: 'telepathy' }));
    expect(await globs.tickCapabilitySteps(boardId, { fileAttachments: true })).toBe(0);
    expect(await globs.tickCapabilitySteps(boardId, {})).toBe(0);
    const events = store.state.events.length;
    expect(await globs.tickCapabilitySteps(boardId, { slack: true })).toBe(1);
    expect(await globs.tickCapabilitySteps(boardId, { slack: true })).toBe(0);
    expect(store.state.events.length).toBe(events + 1);
    expect([...store.state.humanSteps.values()].filter((s) => s.state === 'open').map((s) => s.title).sort()).toEqual(['By hand', 'Unknown capability']);
  });
});
