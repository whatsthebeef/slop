import { describe, expect, it } from 'vitest';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { ReviewEngine, ReviewAnswerInvalid } from '../src/app/review-engine.js';
import { ReviewToolSession } from '../src/app/review-tools.js';
import type { CodeAccess, DirEntry, GrepMatch } from '../src/app/review-tools.js';
import { isToolRequest, parseToolCall, safeGrepPattern, safeRepoPath, toolCap } from '../src/domain/review-tools.js';
import type { ReviewInput } from '../src/domain/independent-review.js';

class FakeAccess implements CodeAccess {
  disposed = 0;
  readonly greps: string[] = [];
  constructor(
    private readonly files: Record<string, string> = {},
    private readonly matches: GrepMatch[] = [],
  ) {}
  readFile(path: string): Promise<string | null> {
    return Promise.resolve(this.files[path] ?? null);
  }
  listDir(path: string): Promise<readonly DirEntry[] | null> {
    const prefix = path === '' ? '' : `${path}/`;
    const names = Object.keys(this.files).filter((f) => f.startsWith(prefix));
    return Promise.resolve(names.length === 0 ? null : names.map((n) => ({ name: n.slice(prefix.length), type: 'file' as const })));
  }
  grep(pattern: string): Promise<readonly GrepMatch[]> {
    this.greps.push(pattern);
    return Promise.resolve(this.matches);
  }
  dispose(): Promise<void> {
    this.disposed += 1;
    return Promise.resolve();
  }
}

class ScriptedLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answers: string[]) {}
  complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    const next = this.answers.shift();
    return next === undefined ? Promise.reject(new Error('No canned answer')) : Promise.resolve(next);
  }
}

const input: ReviewInput = { diff: '+changed', plan: 'Change pay().', reviewGuide: '' };
const verdictsKeepAll = JSON.stringify({ verdicts: [{ index: 0, keep: true, reason: 'real' }] });
const finding = { file: 'src/pay.ts', line: 3, severity: 'high', category: 'bug', title: 'Caller breaks', explanation: 'checkout() passes a string.', suggestedFix: 'Convert it.' };
const reviewJson = JSON.stringify({ summary: 'Changes pay().', findings: [finding] });
const tool = (call: Record<string, unknown>) => JSON.stringify(call);

describe('tool call parsing', () => {
  it('accepts the three read-only tools and rejects anything else', () => {
    expect(parseToolCall(tool({ tool: 'read_file', path: './src//a.ts' }))).toEqual({ ok: true, call: { tool: 'read_file', path: 'src/a.ts' } });
    expect(parseToolCall(tool({ tool: 'list_dir', path: '' }))).toEqual({ ok: true, call: { tool: 'list_dir', path: '' } });
    expect(parseToolCall(tool({ tool: 'grep', pattern: 'pay\\(' }))).toEqual({ ok: true, call: { tool: 'grep', pattern: 'pay\\(' } });
    for (const name of ['bash', 'exec', 'write_file', 'npm']) expect(parseToolCall(tool({ tool: name, command: 'ls' })).ok).toBe(false);
    expect(parseToolCall(tool({ tool: 'read_file', path: '' })).ok).toBe(false);
  });

  it('refuses paths that leave the checkout and patterns that read as options', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a\\b', 'a\u0000b']) expect(safeRepoPath(bad)).toBeNull();
    expect(safeRepoPath('a/b/')).toBe('a/b');
    expect(safeGrepPattern('--open-files-in-pager=sh')).toBeNull();
    expect(safeGrepPattern('-e foo')).toBeNull();
    expect(safeGrepPattern('x'.repeat(300))).toBeNull();
    expect(safeGrepPattern('')).toBeNull();
    expect(safeGrepPattern('foo|bar')).toBe('foo|bar');
  });

  it('tells a tool request from a review', () => {
    expect(isToolRequest(tool({ tool: 'grep', pattern: 'x' }))).toBe(true);
    expect(isToolRequest(reviewJson)).toBe(false);
  });

  it('falls back to the default cap for a missing or invalid setting', () => {
    expect(toolCap(null)).toBe(12);
    expect(toolCap(-1)).toBe(12);
    expect(toolCap(5)).toBe(5);
    expect(toolCap(0)).toBe(0);
    expect(toolCap(10_000)).toBe(50);
  });
});

describe('ReviewToolSession', () => {
  it('renders results, and counts a failed lookup against the cap', async () => {
    const session = new ReviewToolSession(new FakeAccess({ 'src/a.ts': 'const a = 1;' }), 2);
    expect(await session.run({ tool: 'read_file', path: 'src/a.ts' })).toBe('const a = 1;');
    expect(await session.run({ tool: 'read_file', path: 'src/none.ts' })).toBe('No such file: src/none.ts');
    expect(session.callsLeft).toBe(0);
    expect(await session.run({ tool: 'read_file', path: 'src/a.ts' })).toMatch(/Tool limit reached/);
    expect(session.callsUsed).toBe(2);
  });

  it('turns a failing tool into text the model sees', async () => {
    const access = new FakeAccess();
    access.grep = () => Promise.reject(new Error('invalid regular expression'));
    expect(await new ReviewToolSession(access).run({ tool: 'grep', pattern: '(' })).toBe('The tool failed: invalid regular expression');
  });

  it('cuts long output and long match lists', async () => {
    const matches = Array.from({ length: 60 }, (_, i) => ({ path: 'a.ts', line: i + 1, text: 'x' }));
    const session = new ReviewToolSession(new FakeAccess({ big: 'y'.repeat(25_000) }, matches));
    expect(await session.run({ tool: 'read_file', path: 'big' })).toMatch(/\[cut: 5000 more characters\]$/);
    const grep = await session.run({ tool: 'grep', pattern: 'x' });
    expect(grep.split('\n')).toHaveLength(51);
    expect(grep).toMatch(/more than 50 matches/);
  });
});

describe('ReviewEngine with tools', () => {
  it('lets the reviewer read a caller of a changed function, and deletes the clone afterwards', async () => {
    const access = new FakeAccess({ 'src/checkout.ts': 'pay(String(total));' }, [{ path: 'src/checkout.ts', line: 1, text: 'pay(String(total));' }]);
    const llm = new ScriptedLlm([tool({ tool: 'grep', pattern: 'pay\\(' }), tool({ tool: 'read_file', path: 'src/checkout.ts' }), reviewJson, verdictsKeepAll]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input, { access });
    expect(outcome.review.findings).toHaveLength(1);
    expect(access.greps).toEqual(['pay\\(']);
    expect(access.disposed).toBe(1);
    // The second turn shows the first result; the verification pass is shown what was read.
    expect(llm.calls[1]?.prompt).toContain('src/checkout.ts:1:pay(String(total));');
    expect(llm.calls[3]?.prompt).toContain('Code the first reviewer read');
    expect(llm.calls[0]?.system).toContain('"tool": "read_file"');
  });

  it('gives no tools when there is no code access', async () => {
    const llm = new ScriptedLlm([reviewJson, verdictsKeepAll]);
    await new ReviewEngine({ llm }).reviewChange(input);
    expect(llm.calls[0]?.system).not.toContain('"tool"');
  });

  it('stops running tools at the cap and still reaches a review', async () => {
    const access = new FakeAccess({ 'a.ts': 'a' });
    const ask = tool({ tool: 'read_file', path: 'a.ts' });
    const llm = new ScriptedLlm([ask, ask, ask, JSON.stringify({ summary: 'ok', findings: [] })]);
    const outcome = await new ReviewEngine({ llm }).reviewChange(input, { access, toolCap: 2 });
    expect(outcome.review.findings).toEqual([]);
    expect(llm.calls[3]?.prompt).toContain('Tool limit reached (2 calls)');
    expect(access.disposed).toBe(1);
  });

  it('fails, and still deletes the clone, when the model never stops asking', async () => {
    const access = new FakeAccess({ 'a.ts': 'a' });
    const ask = tool({ tool: 'read_file', path: 'a.ts' });
    const llm = new ScriptedLlm(Array.from({ length: 10 }, () => ask));
    await expect(new ReviewEngine({ llm }).reviewChange(input, { access, toolCap: 1 })).rejects.toBeInstanceOf(ReviewAnswerInvalid);
    expect(access.disposed).toBe(1);
  });

  it('runs nothing for a request outside the three tools', async () => {
    const access = new FakeAccess();
    const llm = new ScriptedLlm([tool({ tool: 'bash', command: 'rm -rf /' }), JSON.stringify({ summary: 'ok', findings: [] })]);
    await new ReviewEngine({ llm }).reviewChange(input, { access });
    expect(llm.calls[1]?.prompt).toContain('Your tool request was rejected');
    expect(access.greps).toEqual([]);
  });

  it('deletes the clone when the model call fails', async () => {
    const access = new FakeAccess();
    await expect(new ReviewEngine({ llm: new ScriptedLlm([]) }).reviewChange(input, { access })).rejects.toThrow('No canned answer');
    expect(access.disposed).toBe(1);
  });
});
