import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const agent = (name: string): Promise<string> =>
  readFile(new URL(`../../../catalog/agents/agents/${name}.md`, import.meta.url), 'utf8');

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
});
