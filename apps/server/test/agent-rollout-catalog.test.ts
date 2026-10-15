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

describe('catalog agents: pre-checks, prerequisites and off-process changes', () => {
  it('has the implementer put pre-checks inside scripted infrastructure steps and say when one cannot be pre-checked', async () => {
    const text = await agent('implementer');
    expect(text).toContain('A scripted infrastructure step carries its pre-checks inside the script.');
    expect(text).toContain('`precheck_iam_policy`');
    expect(text).toContain('`precheck_cfn_change_set`');
    expect(text).toContain('`precheck_buildspec`');
    expect(text).toContain('`precheck_policy_json`');
    expect(text).toContain('A step that cannot be pre-checked');
    expect(text).toContain('bash catalog/scripts/step-template.test.sh');
  });

  it('has the investigator tie risk paths and rollout steps to pre-checks and list prerequisites', async () => {
    const text = await agent('investigator');
    expect(text).toContain('is a same, never a sub');
    expect(text).toContain('implies a script with pre-checks');
    expect(text).toContain('each prerequisite the step needs');
  });

  it("has the change reviewer check each step's prerequisites and the pre-checks inside scripted infrastructure steps", async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain("a rollout step whose prerequisites don't exist");
    expect(text).toContain('s14t13');
    expect(text).toMatch(/missing prerequisite is an `IN-SCOPE` finding/);
    expect(text).toContain('whose script has no pre-checks inside it');
    expect(text).toContain('no `trap` cleanup of temporary resources');
  });

  it('has the orchestrator merge rollout globs with Merge and continue and work the checklist from get_glob', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('A glob with rollout steps is merged with Merge and continue.');
    expect(text).toContain('`sstor --glob <id>`');
    expect(text).toContain('call `get_glob` to see which steps are still due');
  });

  it('has the orchestrator start the next generation on a failed step and read the failure attachment', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain("A failed step starts the glob's next generation.");
    expect(text).toContain('`report_step_failed`');
    expect(text).toContain('the glob id, step id and a note');
    expect(text).toContain('strip credentials');
    expect(text).toContain('`Rollout step failed (generation N)`');
    expect(text).toContain('fresh branch from master');
    expect(text).toContain('returns it in full by default');
  });

  it('lists risk_path among the orchestrator\'s escalate_to_same criteria', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('`open_findings`, `risk_path` or `other`');
  });

  it('has the orchestrator update the steps for changes made outside the flow with the existing step tools, never running paid steps', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('Changes made outside the flow.');
    expect(text).toContain('`complete_human_step` with a `note`');
    expect(text).toContain('`dismiss_human_step` with a reason');
    expect(text).toContain('`add_human_step`');
    expect(text).toContain('an edit is a dismiss plus an add');
    expect(text).toContain('never run steps that change paid infrastructure or IAM');
  });
});
