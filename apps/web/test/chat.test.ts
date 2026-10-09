import { describe, expect, it } from 'vitest';
import { RequestError } from '../src/lib/api';
import type { ChatCitation } from '../src/lib/api';
import { stateLabel, unavailableNotice } from '../src/lib/chat';

const cite = (patch: Partial<ChatCitation>): ChatCitation => ({
  n: 1, source: 'decision', sourceLabel: 'Decision', title: 'T', date: '2026-10-01T00:00:00.000Z', link: null, globId: null, status: 'active', supersededBy: null, ...patch,
});

describe('the chat panel helpers', () => {
  it('marks a decision current or superseded by the newer one, and leaves other sources unmarked', () => {
    expect(stateLabel(cite({}))).toBe('current');
    expect(stateLabel(cite({ status: 'superseded', supersededBy: { title: 'Newer', date: null } }))).toBe('superseded by Newer');
    expect(stateLabel(cite({ status: 'superseded' }))).toBe('superseded');
    expect(stateLabel(cite({ source: 'glob_plan' }))).toBeNull();
  });

  it('tells a busy model from an unavailable one, with the reason', () => {
    const busy = new RequestError(503, { code: 'llm_unavailable', message: 'm', reason: 'Bedrock is busy', fix: 'Retried' });
    expect(unavailableNotice(busy)).toMatch(/^The AI is busy right now/);
    expect(unavailableNotice(busy)).toContain('Bedrock is busy');
    const down = new RequestError(503, { code: 'llm_unavailable', message: 'm', reason: 'AWS sign-in expired', fix: 'Run aws sso login' });
    expect(unavailableNotice(down)).toBe('The AI is unavailable right now. (AWS sign-in expired: Run aws sso login)');
    expect(unavailableNotice(new RequestError(403, { code: 'forbidden', message: 'x' }))).toBeNull();
    expect(unavailableNotice(new Error('x'))).toBeNull();
  });
});
