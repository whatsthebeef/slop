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

  it('has the implementer write steps as a short title plus Why / Do this / Check it worked, and say what is not a step', async () => {
    const text = await agent('implementer');
    expect(text).toContain('**Why:**');
    expect(text).toContain('**Do this:**');
    expect(text).toContain('**Check it worked:**');
    expect(text).toContain('What is not a rollout step');
  });

  it('has the implementer put each command-sequence step in a script with its permissions, from the template, and never run it', async () => {
    const text = await agent('implementer');
    expect(text).toContain('**Permissions:**');
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
