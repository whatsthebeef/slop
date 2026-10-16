import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const agent = (name: string): Promise<string> =>
  readFile(new URL(`../../../catalog/agents/agents/${name}.md`, import.meta.url), 'utf8');

describe('catalog agents: questions, steps and decisions', () => {
  it('has the orchestrator, investigator and implementer say a command is never a question and a cross-glob choice is a decision', async () => {
    for (const name of ['orchestrator', 'investigator', 'implementer']) {
      const text = await agent(name);
      expect(text, name).toContain('## Questions, steps and decisions');
      expect(text, name).toMatch(/human step/i);
      expect(text, name).toMatch(/decision glob/i);
      expect(text, name).toMatch(/never a question/i);
    }
  });

  it('has the change_reviewer flag a question that is really a step or a decision', async () => {
    expect(await agent('change_reviewer')).toMatch(/really a human step/);
  });
});
