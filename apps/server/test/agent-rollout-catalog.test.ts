import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const agent = (name: string): Promise<string> => readFile(new URL(`../../../catalog/agents/agents/${name}.md`, import.meta.url), 'utf8');

describe('catalog agents: human steps and rollout', () => {
  it('has the investigator predict human steps and a rollout', async () => {
    const text = await agent('investigator');
    expect(text).toContain('## Human steps');
    expect(text).toContain('`needsRollout`');
  });

  it('has the implementer write a concrete ## Rollout and never run paid-infrastructure steps', async () => {
    const text = await agent('implementer');
    expect(text).toContain('## Rollout');
    expect(text).toContain('infra/deploy/host-deploy.sh');
    expect(text).toContain('infra/deploy/server-env.sh');
    expect(text).toContain('Never run a step that changes paid infrastructure or IAM');
  });

  it('has the implementer write steps as a short title plus Why / Permissions / Run / Check lines, and say what is not a step', async () => {
    const text = await agent('implementer');
    expect(text).toContain('`Why:`');
    expect(text).toContain('`Permissions:`');
    expect(text).toContain('`Run:` one exact command per line');
    expect(text).toContain('`Check:`');
    expect(text).toContain('What is not a rollout step');
  });

  it('has the implementer put each command-sequence step in a script with its permissions, from the template, and never run it', async () => {
    const text = await agent('implementer');
    expect(text).toContain('`Permissions:`');
    expect(text).toContain('Scripts for steps');
    expect(text).toContain('script: <path>');
    expect(text).toContain('scripts/rollout/<glob-id>-<slug>.sh');
    expect(text).toContain('catalog/scripts/step-template.sh');
    expect(text).toContain('You never run it for real');
  });

  it('has the orchestrator require the script and the permissions before the record is written', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('A step that is a command sequence comes with a script.');
    expect(text).toContain('**Permissions:**');
  });

  it('has the change reviewer check the script is in the diff, follows the template shape and passes bash -n and shellcheck', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('`script: <path>` line is missing');
    expect(text).toContain('catalog/scripts/step-template.sh');
    expect(text).toContain('`bash -n` and `shellcheck`');
    expect(text).toContain('`**Permissions:**` line');
  });

  it('has the change reviewer flag notes, pre-merge reviews and optional setup filed as steps', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('a note with no action posing as a step');
    expect(text).toContain('due before the merge');
    expect(text).toContain('optional setup');
  });

  it('has the change reviewer flag a missing or incomplete Rollout as in scope', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('### 10. Check the rollout');
    expect(text).toMatch(/missing section[\s\S]*`IN-SCOPE`/);
  });

  it('has the orchestrator record the Rollout, list the human steps and forbid paid-infrastructure steps', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('## Rollout          (only when');
    expect(text).toContain('## Human steps');
    expect(text).toContain('Agents never run steps that change paid infrastructure or IAM');
    expect(text).toContain('list the human steps');
  });

  it('has the implementer, orchestrator and change reviewer apply the revert test and file other work as an action glob', async () => {
    for (const name of ['implementer', 'orchestrator']) {
      const text = await agent(name);
      expect(text).toContain('The revert test: if this glob were reverted, would the work still be needed?');
      expect(text).toContain('write a rollout step on this glob');
      expect(text).toContain('create an action glob instead (`create_glob` with category `action`, no type, on the right board');
      expect(text).toContain('Never file optional setup as a blocking step.');
      expect(text).toContain('`complete_action`');
      expect(text).toContain('`dismiss_action`');
      expect(text).toContain('Why / Do this (the script path and run command) / Permissions / Check it worked');
    }
    const orchestrator = await agent('orchestrator');
    expect(orchestrator).toContain('lists each action glob you created, with its ID');
    const reviewer = await agent('change_reviewer');
    expect(reviewer).toContain('fails the revert test');
    expect(reviewer).toContain('action glob');
    expect(await agent('investigator')).toContain('revert test');
  });
});

describe('catalog agents: an action waits for its script', () => {
  for (const name of ['implementer', 'orchestrator']) {
    it(`has the ${name} relate an action to the glob that builds its script and name the script`, async () => {
      const text = await agent(name);
      expect(text).toContain('An action that runs a script written by this glob or another open glob waits for it');
      expect(text).toContain('`gate: start`, `until: merged` and the reason "builds its script"');
      expect(text).toContain('`script: <repo path>`');
      expect(text).toContain('refuses Done on the action');
    });

    it(`keeps board-specific paths out of the ${name}'s action rule`, async () => {
      const rule = (await agent(name)).split('\n').find((l) => l.startsWith('- **An action that runs a script')) ?? '';
      expect(rule).not.toBe('');
      expect(rule).not.toMatch(/pocketlab|scripts\/rollout\/s\d+t\d+/i);
    });
  }
});

describe('catalog agents: relations carry a reason and reach across boards', () => {
  for (const name of ['implementer', 'orchestrator']) {
    it(`has the ${name} pass relations explicitly with a reason, as holds or supersedes where they fit`, async () => {
      const text = await agent(name);
      expect(text).toContain("A prerequisite on another board's glob is a relation to that glob (cross-board), not prose");
      expect(text).toContain('`holds` (alias `follows_up`');
      expect(text).toContain('`supersedes`');
      expect(text).toContain('never rely on prose alone');
    });
  }

  it('has the orchestrator pass reasons, read the reply and report a failed rollout step', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('`needs`/`after` WITH `reason`');
    expect(text).toContain('`relations: [{to, reason}]`');
    expect(text).toContain('`ignoredAfter`, `waitingFor`, `holds` and `typeNote`');
    expect(text).toContain('fix the plan if an id was ignored');
    expect(text).toContain('`fail_human_step`');
    expect(text).toContain('this step failed: is there a fix glob?');
  });

  it('has the implementer read ignoredAfter and put the order between rollout steps in Why and a relation', async () => {
    const text = await agent('implementer');
    expect(text).toContain('read `ignoredAfter` and `waitingFor` in the reply');
    expect(text).toContain("An ordering between rollout steps goes in the step's `Why:`");
  });

  it('has the investigator say agents pass the relation reason through on create', async () => {
    const text = await agent('investigator');
    expect(text).toContain('agents pass it through on create');
    expect(text).toContain('A glob on another board is a valid `to`.');
  });
});
