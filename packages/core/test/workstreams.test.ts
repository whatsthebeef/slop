import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { parseWorkstreams, sameWorkstreams, summariseWorkstreams } from '../src/domain/workstreams.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const WS = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  goal: `${name} goal`,
  predictedFiles: ['a.ts'],
  actualFiles: ['a.ts', 'b.ts'],
  needs: [],
  state: 'done',
  attempts: 1,
  conflicts: [],
  durationMinutes: 12,
  ...over,
});
const BLOCK = { fannedOut: true, maxParallel: 2, workstreams: [WS('W0'), WS('W1', { needs: ['W0'] }), WS('W2', { needs: ['W0'] })] };
const record = (value: unknown): string =>
  `# Implementation record: s1f1\n## Workstreams\n| name | status |\n\n\`\`\`workstreams\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n## What was built\n`;

const errorsOf = (value: unknown): readonly string[] => {
  const parsed = parseWorkstreams(record(value));
  if (parsed.kind !== 'invalid') throw new Error(`expected invalid, got ${parsed.kind}`);
  return parsed.errors;
};

describe('parseWorkstreams', () => {
  it('reads a valid block', () => {
    const parsed = parseWorkstreams(record(BLOCK));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') {
      expect(parsed.block.workstreams.map((w) => w.name)).toEqual(['W0', 'W1', 'W2']);
      expect(parsed.block.workstreams[1]).toMatchObject({ needs: ['W0'], state: 'done', attempts: 1, durationMinutes: 12 });
      expect(parsed.block.maxParallel).toBe(2);
    }
  });

  it('says nothing for a record with no workstreams section, and notes a section without a block', () => {
    expect(parseWorkstreams('# Record\n## Approach\nText')).toEqual({ kind: 'none' });
    const missing = parseWorkstreams('# Record\n## Workstreams\n| a | b |\n');
    expect(missing.kind === 'invalid' && missing.errors[0]).toContain('no ```workstreams fenced block');
  });

  it('reads the last block, accepts a null duration and a not-fanned-out record', () => {
    const first = '```workstreams\n{}\n```\n';
    const none = { fannedOut: false, maxParallel: 1, workstreams: [WS('W0', { durationMinutes: null })] };
    const parsed = parseWorkstreams(`## Workstreams\n${first}\n${record(none)}`);
    expect(parsed.kind === 'ok' && parsed.block.fannedOut).toBe(false);
    expect(parseWorkstreams(record({ fannedOut: false, maxParallel: 1, workstreams: [] })).kind).toBe('ok');
  });

  it('reports every problem it finds', () => {
    expect(errorsOf({ maxParallel: 2, workstreams: BLOCK.workstreams })).toEqual(['fannedOut must be a boolean']);
    expect(errorsOf({ ...BLOCK, maxParallel: 0 }).join(';')).toContain('maxParallel');
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { state: 'nope' }), WS('W1', { attempts: -1 })] }).join(';')).toMatch(/state must be one of.*attempts must be/);
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0'), WS('W0')] }).join(';')).toContain('used twice');
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { needs: ['W9'] }), WS('W1')] }).join(';')).toContain('"W9", which is not a workstream');
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { files: 1, conflicts: 'x' }), WS('W1')] }).join(';')).toContain('conflicts must be lists');
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0'), WS('W1', { durationMinutes: 1.5 })] }).join(';')).toContain('durationMinutes');
  });

  it('refuses a needs cycle, a fan-out of fewer than two, and a maxParallel above the workstream count', () => {
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { needs: ['W1'] }), WS('W1', { needs: ['W0'] })] }).join(';')).toContain('cycle through W0, W1');
    expect(errorsOf({ fannedOut: true, maxParallel: 1, workstreams: [WS('W0')] }).join(';')).toContain('at least 2 workstreams');
    expect(errorsOf({ ...BLOCK, maxParallel: 4 }).join(';')).toContain('more than the 3 workstreams');
    expect(errorsOf({ ...BLOCK, maxParallel: 1 }).join(';')).toContain('maxParallel of at least 2');
  });

  it('refuses text that is not JSON or not an object', () => {
    const bad = parseWorkstreams('## Workstreams\n```workstreams\n{nope\n```');
    expect(bad.kind === 'invalid' && bad.errors[0]).toContain('not valid JSON');
    const list = parseWorkstreams('## Workstreams\n```workstreams\n[]\n```');
    expect(list.kind === 'invalid' && list.errors).toEqual(['The block must be a JSON object']);
  });

  it('reads a block in a CRLF record and treats a missing duration as null', () => {
    const noDuration = WS('W0');
    delete noDuration.durationMinutes;
    const text = record({ fannedOut: false, maxParallel: 1, workstreams: [noDuration] }).replace(/\n/g, '\r\n');
    const parsed = parseWorkstreams(text);
    expect(parsed.kind === 'ok' && parsed.block.workstreams[0]?.durationMinutes).toBeNull();
  });

  it('refuses a workstream that needs itself, a non-object entry, an empty block and a fractional maxParallel', () => {
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { needs: ['W0'] }), WS('W1')] }).join(';')).toContain('cycle through W0');
    expect(errorsOf({ ...BLOCK, workstreams: ['W0', WS('W1')] }).join(';')).toContain('workstreams[0] needs a name and a goal');
    expect(errorsOf({ ...BLOCK, workstreams: [WS('W0', { name: '  ' }), WS('W1')] }).join(';')).toContain('needs a name and a goal');
    expect(errorsOf({ ...BLOCK, maxParallel: 1.5 }).join(';')).toContain('maxParallel');
    expect(parseWorkstreams('## Workstreams\n```workstreams\n\n```').kind).toBe('invalid');
  });

  it('compares blocks by what they say', () => {
    const a = parseWorkstreams(record(BLOCK));
    const b = parseWorkstreams(record({ ...BLOCK, workstreams: [WS('W0', { attempts: 2 }), ...BLOCK.workstreams.slice(1)] }));
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('expected ok');
    expect(sameWorkstreams(a.block, a.block)).toBe(true);
    expect(sameWorkstreams(a.block, b.block)).toBe(false);
  });
});

describe('summariseWorkstreams', () => {
  it('keeps only the name, state and conflicts of each workstream', () => {
    const parsed = parseWorkstreams(record({ ...BLOCK, workstreams: [WS('W0', { state: 'running', conflicts: ['a.ts'] }), WS('W1', { state: 'failed', attempts: 2 }), WS('W2')] }));
    if (parsed.kind !== 'ok') throw new Error('expected ok');
    expect(summariseWorkstreams(parsed.block)).toEqual({
      fannedOut: true,
      items: [
        { name: 'W0', state: 'running', conflicts: ['a.ts'] },
        { name: 'W1', state: 'failed', conflicts: [] },
        { name: 'W2', state: 'done', conflicts: [] },
      ],
    });
  });
});

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const ADMIN = 'admin@example.com';
const OPTIONS = { commitSha: 'abc', runId: null, agentSetVersion: null };

describe('the record hook', () => {
  let store: MemoryStore;
  let artifacts: ArtifactService;
  let globs: GlobService;
  let globId: string;
  let boardId: number;

  const put = async (content: string, options = OPTIONS) => {
    const stored = unwrap(await artifacts.putArtifact(ADMIN, globId, 'implementation_plan', content, options));
    if ('ignored' in stored) throw new Error('ignored');
    return stored;
  };
  const recorded = () => store.state.events.filter((e) => e.type === 'WorkstreamsRecorded');

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-14T12:00:00.000Z' };
    artifacts = new ArtifactService({ store, clock, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] })).id;
    globId = unwrap(await globs.create(ADMIN, { boardId, title: 'Big', type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null })).id;
  });

  it('stores a valid block without a note and records it once, however often the record is pushed', async () => {
    const first = await put(record(BLOCK));
    expect(first.provenance.validation).toBeUndefined();
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]?.data).toMatchObject({ fannedOut: true, maxParallel: 2, version: 1, commitSha: 'abc', runId: null });
    await put(`${record(BLOCK)}\nMore prose`, { ...OPTIONS, commitSha: 'def' });
    expect(recorded()).toHaveLength(1);
  });

  it('records a changed block with the version it came from', async () => {
    await put(record(BLOCK));
    await put(record({ ...BLOCK, workstreams: [WS('W0'), WS('W1', { state: 'failed', attempts: 2, needs: ['W0'] }), WS('W2', { needs: ['W0'] })] }), {
      ...OPTIONS,
      commitSha: 'def',
    });
    expect(recorded().map((e) => e.data.version)).toEqual([1, 2]);
    expect(recorded()[1]?.data.workstreams).toMatchObject([{ name: 'W0' }, { name: 'W1', state: 'failed', attempts: 2 }, { name: 'W2' }]);
  });

  it('keeps a malformed block as text with a note and records nothing, and a record without the section is silent', async () => {
    const bad = await put(record({ ...BLOCK, maxParallel: 0 }));
    expect(bad.provenance.validation).toContain('Workstreams block not parsed');
    expect(bad.content).toContain('## Workstreams');
    expect(recorded()).toHaveLength(0);
    const small = await put('# Record\n## Approach\nSmall');
    expect(small.provenance.validation).toBeUndefined();
    expect(recorded()).toHaveLength(0);
  });

  it('does not record the same block again after a malformed push in between', async () => {
    await put(record(BLOCK));
    await put(record({ ...BLOCK, maxParallel: 0 }));
    await put(`${record(BLOCK)}\nMore prose`);
    expect(recorded()).toHaveLength(1);
  });

  it('does not parse the block in other artifact kinds', async () => {
    const stored = unwrap(await artifacts.putArtifact(ADMIN, globId, 'local_review', record(BLOCK), OPTIONS));
    if ('ignored' in stored) throw new Error('ignored');
    expect(recorded()).toHaveLength(0);
  });

  it('does not record the same block again after a malformed push in between', async () => {
    await put(record(BLOCK));
    await put(record({ ...BLOCK, maxParallel: 0 }), { ...OPTIONS, commitSha: 'bad' });
    expect(recorded()).toHaveLength(1);
    await put(record(BLOCK), { ...OPTIONS, commitSha: 'fix' });
    expect(recorded().map((e) => e.data.version)).toEqual([1]);
    await put(record({ ...BLOCK, maxParallel: 3 }), { ...OPTIONS, commitSha: 'new' });
    expect(recorded().map((e) => e.data.version)).toEqual([1, 4]);
  });

  it('workstreamsOf gives the latest block of a fanned-out glob, and nothing for a small one or an unparsed record', async () => {
    expect((await globs.workstreamsOf(boardId)).size).toBe(0);
    await put(record(BLOCK));
    await put(record({ ...BLOCK, workstreams: [WS('W0'), WS('W1', { state: 'running', needs: ['W0'] }), WS('W2', { needs: ['W0'] })] }), { ...OPTIONS, commitSha: 'def' });
    const found = await globs.workstreamsOf(boardId);
    expect(found.get(globId)?.items.map((i) => `${i.name}:${i.state}`)).toEqual(['W0:done', 'W1:running', 'W2:done']);
    await put(record({ fannedOut: false, maxParallel: 1, workstreams: [] }), { ...OPTIONS, commitSha: 'small' });
    expect((await globs.workstreamsOf(boardId)).has(globId)).toBe(false);
  });
});
