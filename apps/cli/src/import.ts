import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';
import { docIds, fetchDoc } from './gdocs.js';
import type { Fetch } from './http.js';
import { JiraClient, importJql } from './jira.js';

export const IMPORT_USAGE =
  'import jira --board <n> --project <KEY> [--jql <query>] [--since <YYYY-MM-DD>] [--docs]';

/** The most items slop takes in one call. */
const BATCH = 50;

export interface ImportDeps {
  readonly client: {
    rest(method: string, path: string, body?: unknown): Promise<unknown>;
  };
  readonly fetch: Fetch;
  /** The process environment: the Jira and Google credentials are read from it and go nowhere but their own APIs. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly log: (message: string) => void;
}

interface Item {
  readonly source: 'jira' | 'gdoc';
  readonly sourceKey: string;
  readonly title: string;
  readonly text: string;
  readonly sourceType: 'thread' | 'doc';
  readonly sourceLabel: string;
  readonly occurredAt?: string;
}

const outcomesSchema = z.object({
  outcomes: z.array(
    z.union([
      z.object({ sourceKey: z.string(), result: z.enum(['added', 'updated', 'skipped']) }),
      z.object({ sourceKey: z.string(), result: z.literal('failed'), reason: z.string() }),
    ]),
  ),
});

const VALUE_FLAGS = ['--board', '--project', '--jql', '--since'] as const;

const needEnv = (env: ImportDeps['env'], name: string): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new SlopError(`import: set ${name} in the environment`);
  return value;
};

/** `slop import jira`: reads a Jira project (and the Google Docs its issues link to) and delivers it to the board's inbox, archived. */
export async function importCommand(args: readonly string[], deps: ImportDeps): Promise<void> {
  const usage = `usage: slop ${IMPORT_USAGE}`;
  const [what, ...rest] = args;
  if (what !== 'jira') throw new UsageError(usage);
  const values = new Map<string, string>();
  let withDocs = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value\n${usage}`);
      values.set(arg, value);
    } else if (arg === '--docs') {
      withDocs = true;
    } else {
      throw new UsageError(`unknown argument ${arg}\n${usage}`);
    }
  }
  const board = values.get('--board');
  if (board === undefined || !/^[1-9]\d*$/.test(board)) throw new UsageError(`--board <n> is required\n${usage}`);
  const project = values.get('--project');
  if (project === undefined || !/^[A-Za-z][A-Za-z0-9_]*$/.test(project))
    throw new UsageError(`--project <KEY> is required\n${usage}`);
  const since = values.get('--since');
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since))
    throw new UsageError('--since must be a date like 2025-01-31');

  const site = needEnv(deps.env, 'JIRA_SITE_URL').replace(/\/+$/, '');
  if (!site.startsWith('https://')) throw new SlopError('import: JIRA_SITE_URL must be an https:// URL');
  const jira = new JiraClient(
    { site, email: needEnv(deps.env, 'JIRA_EMAIL'), token: needEnv(deps.env, 'JIRA_API_TOKEN') },
    deps.fetch,
  );
  const googleToken = withDocs ? needEnv(deps.env, 'GOOGLE_ACCESS_TOKEN') : undefined;

  const counts = { added: 0, updated: 0, skipped: 0, failed: 0 };
  const failures: string[] = [];
  const unfetched: string[] = [];
  const pending: Item[] = [];
  const docSources = new Map<string, string>();

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const reply = outcomesSchema.safeParse(
      await deps.client.rest('POST', `/api/boards/${board}/inbox/import`, { items: batch }),
    );
    if (!reply.success) throw new SlopError('import: unexpected response from slop');
    for (const outcome of reply.data.outcomes) {
      counts[outcome.result] += 1;
      if (outcome.result === 'failed') failures.push(`${outcome.sourceKey}: ${outcome.reason}`);
    }
  };
  const queue = async (item: Item): Promise<void> => {
    pending.push(item);
    if (pending.length >= BATCH) await flush();
  };

  for await (const { issue, key } of jira.issues(importJql(project, values.get('--jql'), since))) {
    if (issue === undefined) {
      counts.failed += 1;
      failures.push(`${key}: Jira's issue could not be read`);
      continue;
    }
    await queue({
      source: 'jira',
      sourceKey: issue.key,
      title: issue.title,
      text: issue.text,
      sourceType: 'thread',
      sourceLabel: `Jira ${issue.key}`,
      ...(issue.created === undefined ? {} : { occurredAt: issue.created }),
    });
    if (googleToken === undefined) continue;
    const links = await jira.remoteLinks(issue.key).catch((error: unknown) => {
      failures.push(`${issue.key}: web links not read (${error instanceof Error ? error.message : String(error)})`);
      return [];
    });
    for (const id of docIds([issue.text, ...links].join('\n'))) if (!docSources.has(id)) docSources.set(id, issue.key);
  }
  await flush();

  if (googleToken !== undefined) {
    for (const [id, from] of docSources) {
      const doc = await fetchDoc(id, googleToken, deps.fetch);
      if (!doc.ok) {
        unfetched.push(`${id} (linked from ${from}): ${doc.reason}`);
        continue;
      }
      await queue({
        source: 'gdoc',
        sourceKey: id,
        title: doc.title,
        text: `${doc.title}\n\n${doc.text}`,
        sourceType: 'doc',
        sourceLabel: `Google Doc, linked from ${from}`,
        ...(doc.modified === undefined ? {} : { occurredAt: doc.modified }),
      });
    }
    await flush();
  }

  deps.stdout(
    `${[
      `Imported from Jira ${project}${withDocs ? ' and its linked Google Docs' : ''} into board ${board}:`,
      `  added ${String(counts.added)}, updated ${String(counts.updated)}, skipped ${String(counts.skipped)}, failed ${String(counts.failed)}`,
      ...(failures.length > 0 ? ['Failed:', ...failures.map((f) => `  ${f}`)] : []),
      ...(unfetched.length > 0 ? [`Google Docs not fetched (${String(unfetched.length)}):`, ...unfetched.map((u) => `  ${u}`)] : []),
    ].join('\n')}\n`,
  );
}
