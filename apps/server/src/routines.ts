import { readFile } from 'node:fs/promises';
import type { RoutineDirectory } from '@slop/core';
import { z } from 'zod';

const routinesSchema = z.record(z.string(), z.object({ url: z.url(), token: z.string().min(1) }));

export interface RoutineSecret {
  readonly url: string;
  readonly token: string;
}

/**
 * Each developer's routine fire URL and token. Locally a gitignored file keyed by email
 * (`.routines.json`); in production Secrets Manager at `slop/routines/<email>`.
 */
export class FileRoutines implements RoutineDirectory {
  constructor(private readonly file: string) {}

  private async all(): Promise<Record<string, RoutineSecret>> {
    try {
      const parsed = routinesSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async hasRoutine(email: string): Promise<boolean> {
    return (await this.secretFor(email)) !== null;
  }

  async secretFor(email: string): Promise<RoutineSecret | null> {
    return (await this.all())[email.toLowerCase()] ?? null;
  }
}

export type FireResult =
  | { readonly outcome: 'fired'; readonly sessionId: string | null; readonly sessionUrl: string | null }
  | { readonly outcome: 'retry'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string };

const fireResponse = z.object({
  claude_code_session_id: z.string().optional(),
  claude_code_session_url: z.string().optional(),
});

/** Fires a routine through its API trigger with this run's instructions as the text. */
export const fireRoutine = async (secret: RoutineSecret, text: string): Promise<FireResult> => {
  const response = await fetch(secret.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret.token}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = fireResponse.safeParse(body);
    return {
      outcome: 'fired',
      sessionId: parsed.success ? (parsed.data.claude_code_session_id ?? null) : null,
      sessionUrl: parsed.success ? (parsed.data.claude_code_session_url ?? null) : null,
    };
  }
  const message = `Routine fire failed (${String(response.status)})`;
  // Rate limits and server errors are retried with backoff; anything else needs a person.
  return response.status === 429 || response.status >= 500
    ? { outcome: 'retry', reason: message }
    : { outcome: 'failed', reason: message };
};

/** The text a routine run receives: which glob, which run, and how to start. */
export const runInstructions = (glob: { id: string; title: string }, runId: string): string =>
  [
    `Slop glob ${glob.id}: ${glob.title}`,
    `Run ID: ${runId}`,
    '',
    `Work on the glob's branch, ${glob.id}, which already exists on origin with an open draft PR: run \`git fetch origin ${glob.id} && git checkout -B ${glob.id} origin/${glob.id}\` first. Push only to ${glob.id} (\`git push origin ${glob.id}\`); never create or push a claude/ branch, and never open a new PR.`,
    '',
    `Run /run-glob ${glob.id} --run ${runId}. If that command is not available, read .claude/agents/orchestrator.md and follow it for glob ${glob.id} in unattended mode with run ID ${runId}.`,
    "Start by calling slop's get_glob and get_context for the glob, passing the run ID.",
    `When the work is pushed, call slop's mark_ready for ${glob.id} with the run ID (do not use gh). If you cannot finish, call report_failure with the run ID.`,
  ].join('\n');
