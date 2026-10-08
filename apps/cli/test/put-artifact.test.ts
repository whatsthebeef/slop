import { describe, expect, it } from 'vitest';
import type { ToolArguments } from '../src/client.js';
import { SlopError, UsageError } from '../src/errors.js';
import { putArtifactCommand } from '../src/put-artifact.js';

function setup(files: Record<string, string>) {
  const calls: { tool: string; args: ToolArguments }[] = [];
  const out: string[] = [];
  const deps = {
    client: {
      call: (tool: string, args: ToolArguments = {}) => {
        calls.push({ tool, args });
        return Promise.resolve({ id: 'a1', kind: 'local_review', version: 2 });
      },
    },
    readInput: (path: string) => {
      const text = files[path];
      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
    },
    stdout: (t: string) => out.push(t),
  };
  return { calls, out, deps };
}

describe('slop put-artifact', () => {
  it('reads the file and passes its exact text with every option', async () => {
    const big = `# Review\n${'x'.repeat(50_000)}\n`;
    const { calls, out, deps } = setup({ 'r.md': big });
    const stats = '{"riskTier":"normal","reviewRounds":1,"maxReviewRounds":2,"testFailRounds":0}';
    await putArtifactCommand(
      [
        's1t4',
        '--kind',
        'local_review',
        '--file',
        'r.md',
        '--commit',
        'abc',
        '--agent-set',
        '3',
        '--review-stats',
        stats,
        '--run',
        'r1',
      ],
      deps,
    );
    expect(calls).toEqual([
      {
        tool: 'put_artifact',
        args: {
          id: 's1t4',
          kind: 'local_review',
          content: big,
          commitSha: 'abc',
          agentSetVersion: 3,
          runId: 'r1',
          reviewStats: JSON.parse(stats) as unknown,
        },
      },
    ]);
    expect(out.join('')).toContain('"version":2');
  });

  it('reads stdin for --file -', async () => {
    const { calls, deps } = setup({ '-': 'from stdin' });
    await putArtifactCommand(['s1t4', '--kind', 'postplan', '--file', '-'], deps);
    expect(calls[0]?.args).toEqual({ id: 's1t4', kind: 'postplan', content: 'from stdin' });
  });

  it.each([
    [[]],
    [['s1t4', '--file', 'r.md']],
    [['s1t4', '--kind', 'plan', '--file', 'r.md']],
    [['s1t4', '--kind', 'postplan']],
    [['s1t4', '--kind', 'postplan', '--file']],
    [['s1t4', '--kind', 'postplan', '--file', 'r.md', '--bogus']],
    [['s1t4', '--kind', 'postplan', '--file', 'r.md', '--agent-set', 'x']],
    [['s1t4', '--kind', 'local_review', '--file', 'r.md', '--review-stats', '{}']],
    [['s1t4', 's1t5', '--kind', 'postplan', '--file', 'r.md']],
  ])('refuses bad arguments %j', async (args) => {
    const { calls, deps } = setup({ 'r.md': 'x' });
    await expect(putArtifactCommand(args, deps)).rejects.toBeInstanceOf(UsageError);
    expect(calls).toEqual([]);
  });

  it('fails on a missing or empty file without calling slop', async () => {
    const { calls, deps } = setup({ 'empty.md': '  \n' });
    await expect(
      putArtifactCommand(['s1t4', '--kind', 'postplan', '--file', 'nope.md'], deps),
    ).rejects.toBeInstanceOf(SlopError);
    await expect(
      putArtifactCommand(['s1t4', '--kind', 'postplan', '--file', 'empty.md'], deps),
    ).rejects.toThrow('empty');
    expect(calls).toEqual([]);
  });
});
