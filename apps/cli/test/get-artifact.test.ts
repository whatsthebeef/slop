import { describe, expect, it } from 'vitest';
import type { ToolArguments } from '../src/client.js';
import { SlopError, UsageError } from '../src/errors.js';
import { getArtifactCommand } from '../src/get-artifact.js';

function setup(replies: Record<string, unknown>) {
  const calls: { tool: string; args: ToolArguments }[] = [];
  const out: string[] = [];
  const written: Record<string, string> = {};
  let failWrite = false;
  const deps = {
    client: {
      call: (tool: string, args: ToolArguments = {}) => {
        calls.push({ tool, args });
        return Promise.resolve(replies[tool]);
      },
    },
    writeFile: (path: string, text: string) => {
      if (failWrite) return Promise.reject(new Error('EACCES'));
      written[path] = text;
      return Promise.resolve();
    },
    stdout: (t: string) => out.push(t),
  };
  return { calls, out, written, deps, failWrites: () => (failWrite = true) };
}

const script = { content: '#!/bin/sh\necho hi\n', label: 'action: iam', version: 2 };

describe('slop get-artifact', () => {
  it('saves the script with --out, by the kind as a word or as --kind, with the label given', async () => {
    const { calls, out, written, deps } = setup({ get_artifact: script });
    await getArtifactCommand(['s1a2', 'rollout_script', '--label', 'action: iam', '--out', 'run.sh'], deps);
    expect(calls).toEqual([{ tool: 'get_artifact', args: { id: 's1a2', kind: 'rollout_script', label: 'action: iam' } }]);
    expect(written['run.sh']).toBe(script.content);
    expect(out.join('')).toBe('s1a2 rollout_script v2 written to run.sh\n');
    await getArtifactCommand(['s1a2', '--kind', 'rollout_script', '--label', 'action: iam', '--out', 'b.sh'], deps);
    expect(written['b.sh']).toBe(script.content);
  });

  it('prints to stdout without --out, and finds the one script by itself', async () => {
    const { calls, out, deps } = setup({ get_artifact: { content: 'echo hi' }, get_glob: { artifacts: [{ kind: 'plan', label: '' }, { kind: 'rollout_script', label: 'action: iam' }] } });
    await getArtifactCommand(['s1a2', 'rollout_script'], deps);
    expect(calls.map((c) => c.tool)).toEqual(['get_glob', 'get_artifact']);
    expect(calls[1]?.args).toEqual({ id: 's1a2', kind: 'rollout_script', label: 'action: iam' });
    expect(out.join('')).toBe('echo hi\n');
  });

  it('asks for --label when there are several scripts, and says when there is none', async () => {
    const several = setup({ get_glob: { artifacts: [{ kind: 'rollout_script', label: 'a' }, { kind: 'rollout_script', label: 'b' }] } });
    await expect(getArtifactCommand(['s1a2', 'rollout_script'], several.deps)).rejects.toThrow('pass --label');
    const none = setup({ get_glob: { artifacts: [] } });
    await expect(getArtifactCommand(['s1a2', 'rollout_script'], none.deps)).rejects.toThrow('no rollout_script yet');
  });

  it.each([[[]], [['s1a2']], [['s1a2', 'nope']], [['s1a2', 'rollout_script', '--bogus']], [['s1a2', 'rollout_script', '--out']], [['s1a2', 'test_plan', '--kind', 'rollout_script']], [['s1a2', 'a', 'b']]])(
    'refuses bad arguments %j',
    async (args) => {
      const { calls, deps } = setup({});
      await expect(getArtifactCommand(args, deps)).rejects.toBeInstanceOf(UsageError);
      expect(calls).toEqual([]);
    },
  );

  it('fails when slop answers oddly or the file cannot be written', async () => {
    await expect(getArtifactCommand(['s1a2', 'test_plan'], setup({ get_artifact: { nope: 1 } }).deps)).rejects.toBeInstanceOf(SlopError);
    const s = setup({ get_artifact: script });
    s.failWrites();
    await expect(getArtifactCommand(['s1a2', 'test_plan', '--out', '/x'], s.deps)).rejects.toThrow('could not write');
  });
});
