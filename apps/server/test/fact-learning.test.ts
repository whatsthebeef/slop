import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('fact learnings and spec drift', () => {
  it('accepts fact as a learning type', () => {
    expect(repoFile('packages/core/src/domain/kb.ts')).toContain("['gotcha', 'pattern', 'agent-behaviour', 'fact']");
  });

  it('documents the fact type in submit_learning guidance and the KB pipeline prompts', () => {
    expect(repoFile('apps/server/src/mcp/server.ts')).toContain('fact (how the system is now');
    const pipeline = repoFile('packages/core/src/app/kb-pipeline.ts');
    expect(pipeline).toContain('A learning of type "fact" states how the system is now (architecture');
    expect(pipeline).toContain('replaces the outdated description');
  });

  it("has the orchestrator's finalise step submit facts", () => {
    const orchestrator = repoFile('catalog/agents/agents/orchestrator.md');
    expect(orchestrator).toContain('`gotcha`, `pattern`, `agent-behaviour` and `fact`');
    expect(orchestrator).toContain('Submit one per change');
    expect(repoFile('catalog/agents/commands/finalise.md')).toContain('`fact` learning');
    expect(repoFile('catalog/agents/agents/investigator.md')).toContain('Stale descriptions');
  });

  it('has both reviewers check for spec and guide drift', () => {
    expect(repoFile('catalog/agents/agents/change_reviewer.md')).toContain('Spec and guide drift');
    expect(repoFile('packages/core/src/domain/independent-review.ts')).toContain('spec or guide describes');
    expect(repoFile('catalog/kb/review_guide_template.md')).toContain('Spec and guide drift');
  });
});
