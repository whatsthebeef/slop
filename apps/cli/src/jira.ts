import { z } from 'zod';
import { SlopError } from './errors.js';
import { HTTP_TIMEOUT_MS, type Fetch } from './http.js';
import { describeError, parseJsonOrUndefined } from './util.js';

/** A Jira Cloud site and the credentials for it: read from the environment, never sent to slop. */
export interface JiraAuth {
  /** The site, without a trailing slash (https://example.atlassian.net). */
  readonly site: string;
  readonly email: string;
  readonly token: string;
}

const PAGE_SIZE = 50;
const FIELDS = 'summary,description,comment,status,issuetype,issuelinks,created,updated';

/** A node of Jira's document format (ADF): the description and comments are trees of these. */
const adfSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(adfSchema).optional(),
  }),
);
interface AdfNode {
  type?: string | undefined;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  content?: AdfNode[] | undefined;
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'panel', 'listItem', 'tableRow']);

/** Plain text of an ADF tree (or of the plain string an older site returns). */
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  const parsed = adfSchema.safeParse(node);
  if (!parsed.success) return '';
  const walk = (n: AdfNode): string => {
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return typeof n.attrs?.text === 'string' ? n.attrs.text : '';
    if (n.type === 'inlineCard') return typeof n.attrs?.url === 'string' ? n.attrs.url : '';
    const inner = (n.content ?? []).map(walk).join(n.type === 'tableRow' ? ' | ' : '');
    const own = n.text ?? inner;
    if (n.type === 'listItem') return `- ${own.trim()}\n`;
    return BLOCKS.has(n.type ?? '') ? `${own.trim()}\n` : own;
  };
  return walk(parsed.data).replace(/\n{3,}/g, '\n\n').trim();
}

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().default(''),
    description: z.unknown().optional(),
    status: z.object({ name: z.string() }).nullish(),
    issuetype: z.object({ name: z.string() }).nullish(),
    created: z.string().optional(),
    updated: z.string().optional(),
    comment: z
      .object({
        comments: z.array(
          z.object({
            author: z.object({ displayName: z.string() }).nullish(),
            created: z.string().optional(),
            body: z.unknown().optional(),
          }),
        ),
      })
      .nullish(),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ outward: z.string(), inward: z.string() }),
          outwardIssue: z.object({ key: z.string() }).optional(),
          inwardIssue: z.object({ key: z.string() }).optional(),
        }),
      )
      .nullish(),
  }),
});

const searchSchema = z.object({
  issues: z.array(z.unknown()),
  nextPageToken: z.string().nullish(),
});

const remoteLinksSchema = z.array(z.object({ object: z.object({ url: z.string() }) }));

export interface JiraIssue {
  readonly key: string;
  readonly title: string;
  /** The issue as text: header line, links, description and comments. */
  readonly text: string;
  readonly created: string | undefined;
  readonly updated: string | undefined;
}

export const importJql = (project: string, jql: string | undefined, since: string | undefined): string => {
  const parts = [`project = "${project.replace(/"/g, '')}"`];
  if (since !== undefined) parts.push(`updated >= "${since}"`);
  if (jql !== undefined && jql.trim() !== '') parts.push(`(${jql})`);
  return `${parts.join(' AND ')} ORDER BY updated ASC`;
};

export function issueOf(raw: unknown): JiraIssue | undefined {
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { key, fields } = parsed.data;
  const header = [
    fields.issuetype?.name !== undefined ? `Type: ${fields.issuetype.name}` : '',
    fields.status?.name !== undefined ? `Status: ${fields.status.name}` : '',
    fields.created !== undefined ? `Created: ${fields.created}` : '',
    fields.updated !== undefined ? `Updated: ${fields.updated}` : '',
  ].filter((p) => p !== '');
  const links = (fields.issuelinks ?? []).flatMap((l) =>
    l.outwardIssue !== undefined
      ? [`${l.type.outward} ${l.outwardIssue.key}`]
      : l.inwardIssue !== undefined
        ? [`${l.type.inward} ${l.inwardIssue.key}`]
        : [],
  );
  const description = adfText(fields.description);
  const comments = (fields.comment?.comments ?? []).flatMap((c) => {
    const body = adfText(c.body);
    return body === '' ? [] : [`- ${c.author?.displayName ?? 'Unknown'} (${c.created ?? ''}): ${body}`];
  });
  const text = [
    `${key}: ${fields.summary}`,
    header.join(' | '),
    links.length > 0 ? `Links: ${links.join('; ')}` : '',
    description === '' ? '' : `\nDescription\n${description}`,
    comments.length > 0 ? `\nComments\n${comments.join('\n')}` : '',
  ]
    .filter((p) => p !== '')
    .join('\n');
  return { key, title: `${key}: ${fields.summary}`, text, created: fields.created, updated: fields.updated };
}

export class JiraClient {
  constructor(
    private readonly auth: JiraAuth,
    private readonly fetch: Fetch,
  ) {}

  private async get(path: string): Promise<unknown> {
    const url = `${this.auth.site}${path}`;
    const basic = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SlopError(`could not reach Jira at ${this.auth.site}: ${describeError(error)}`);
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300)
      throw new SlopError(`Jira ${path.split('?')[0] ?? path} failed (${String(response.status)}): ${text.slice(0, 200)}`);
    const value = parseJsonOrUndefined(text);
    if (value === undefined) throw new SlopError('Jira sent a reply that is not JSON');
    return value;
  }

  /** Every issue the query matches, page by page (callers stop early by returning from the loop). */
  async *issues(jql: string): AsyncGenerator<{ issue: JiraIssue | undefined; key: string }> {
    let token: string | null | undefined;
    do {
      const query = new URLSearchParams({ jql, fields: FIELDS, maxResults: String(PAGE_SIZE) });
      if (token) query.set('nextPageToken', token);
      const page = searchSchema.safeParse(await this.get(`/rest/api/3/search/jql?${query.toString()}`));
      if (!page.success) throw new SlopError('Jira search: unexpected response');
      for (const raw of page.data.issues) {
        const issue = issueOf(raw);
        yield { issue, key: issue?.key ?? '(unknown)' };
      }
      token = page.data.nextPageToken;
    } while (token);
  }

  /** The URLs on an issue's web links (a Google Doc linked there is not in its text). */
  async remoteLinks(key: string): Promise<string[]> {
    const parsed = remoteLinksSchema.safeParse(
      await this.get(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`),
    );
    return parsed.success ? parsed.data.map((l) => l.object.url) : [];
  }
}
