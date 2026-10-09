import { describe, expect, it } from 'vitest';
import { SlopError, UsageError } from '../src/errors.js';
import { docIds } from '../src/gdocs.js';
import { importCommand, type ImportDeps } from '../src/import.js';
import { adfText, importJql, issueOf } from '../src/jira.js';

const SITE = 'https://acme.atlassian.net';
const DOC_A = 'DocAAAAAAAAAAAAAAAA1';
const DOC_B = 'DocBBBBBBBBBBBBBBBB2';
const doc = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

const adf = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  key: `APP-${String(n)}`,
  fields: {
    summary: `Issue ${String(n)}`,
    description: adf(`Description ${String(n)}`),
    status: { name: 'Done' },
    issuetype: { name: 'Story' },
    created: '2025-01-0' + String(n) + 'T10:00:00.000+0000',
    updated: '2025-02-0' + String(n) + 'T10:00:00.000+0000',
    comment: { comments: [{ author: { displayName: 'Ana' }, created: '2025-01-05', body: adf('We chose Postgres') }] },
    issuelinks: [{ type: { outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'APP-99' } }],
    ...extra,
  },
});

interface Setup {
  readonly deps: ImportDeps;
  readonly out: string[];
  readonly posts: { path: string; items: { sourceKey: string; source: string; text: string }[] }[];
  readonly requests: { url: string; auth: string | undefined }[];
}

function setup(options: {
  pages: unknown[][];
  remote?: Record<string, string[]>;
  docs?: Record<string, number | string>;
  env?: Record<string, string>;
  results?: (key: string) => 'added' | 'updated' | 'skipped' | { failed: string };
}): Setup {
  const out: string[] = [];
  const posts: Setup['posts'] = [];
  const requests: Setup['requests'] = [];
  let page = 0;
  const fetch: ImportDeps['fetch'] = (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: input, auth: headers.get('authorization') ?? undefined });
    const url = new URL(input);
    if (url.pathname === '/rest/api/3/search/jql') {
      const issues = options.pages[page] ?? [];
      page += 1;
      return Promise.resolve(
        Response.json({ issues, ...(page < options.pages.length ? { nextPageToken: `t${String(page)}` } : {}) }),
      );
    }
    const remote = /\/issue\/([^/]+)\/remotelink$/.exec(url.pathname);
    if (remote?.[1] !== undefined)
      return Promise.resolve(Response.json((options.remote?.[remote[1]] ?? []).map((u) => ({ object: { url: u } }))));
    const drive = /\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    if (drive?.[1] !== undefined) {
      const spec = options.docs?.[drive[1]];
      if (typeof spec === 'number') return Promise.resolve(new Response('no', { status: spec }));
      if (drive[2] === undefined) return Promise.resolve(Response.json({ name: 'Design notes', modifiedTime: '2025-02-01T00:00:00Z' }));
      return Promise.resolve(new Response(spec ?? 'Doc body text'));
    }
    return Promise.reject(new Error(`unexpected ${input}`));
  };
  const deps: ImportDeps = {
    fetch,
    env: {
      JIRA_SITE_URL: SITE,
      JIRA_EMAIL: 'me@acme.com',
      JIRA_API_TOKEN: 'tok',
      GOOGLE_ACCESS_TOKEN: 'gtok',
      ...options.env,
    },
    stdout: (t) => out.push(t),
    log: () => undefined,
    client: {
      rest: (_method, path, body) => {
        const items = (body as { items: { sourceKey: string; source: string; text: string }[] }).items;
        posts.push({ path, items });
        return Promise.resolve({
          outcomes: items.map((i) => {
            const r = options.results?.(i.sourceKey) ?? 'added';
            return typeof r === 'string'
              ? { sourceKey: i.sourceKey, result: r }
              : { sourceKey: i.sourceKey, result: 'failed', reason: r.failed };
          }),
        });
      },
    },
  };
  return { deps, out, posts, requests };
}

describe('jira text', () => {
  it('flattens ADF into plain text', () => {
    expect(
      adfText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
        ],
      }),
    ).toBe('One\ntwo\n- item');
    expect(adfText(null)).toBe('');
    expect(adfText('plain')).toBe('plain');
  });

  it('turns an issue into a titled text with status, links, description and comments', () => {
    const parsed = issueOf(issue(1));
    expect(parsed?.title).toBe('APP-1: Issue 1');
    expect(parsed?.text).toContain('Status: Done');
    expect(parsed?.text).toContain('Links: blocks APP-99');
    expect(parsed?.text).toContain('Description\nDescription 1');
    expect(parsed?.text).toContain('- Ana (2025-01-05): We chose Postgres');
    expect(issueOf({ nope: true })).toBeUndefined();
  });

  it('builds the query from the project, --since and --jql', () => {
    expect(importJql('APP', undefined, undefined)).toBe('project = "APP" ORDER BY updated ASC');
    expect(importJql('APP', 'type = Bug', '2025-01-31')).toBe(
      'project = "APP" AND updated >= "2025-01-31" AND (type = Bug) ORDER BY updated ASC',
    );
  });
});

describe('docIds', () => {
  it('finds each Google Doc once, in order, in any URL form', () => {
    expect(
      docIds(`see ${doc(DOC_A)} and https://docs.google.com/document/u/1/d/${DOC_B}/view, again ${doc(DOC_A)}; https://docs.google.com/spreadsheets/d/${DOC_A}`),
    ).toEqual([DOC_A, DOC_B]);
    expect(docIds('nothing here')).toEqual([]);
  });
});

describe('slop import jira', () => {
  it('pages through the issues, authenticates with basic auth and posts them as jira items', async () => {
    const s = setup({ pages: [[issue(1), issue(2)], [issue(3)]] });
    await importCommand(['jira', '--board', '15', '--project', 'APP'], s.deps);
    expect(s.requests.every((r) => r.auth === `Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`)).toBe(true);
    expect(s.requests.filter((r) => r.url.includes('/search/jql'))).toHaveLength(2);
    expect(s.requests[1]?.url).toContain('nextPageToken=t1');
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]?.path).toBe('/api/boards/15/inbox/import');
    expect(s.posts[0]?.items.map((i) => [i.source, i.sourceKey])).toEqual([
      ['jira', 'APP-1'],
      ['jira', 'APP-2'],
      ['jira', 'APP-3'],
    ]);
    expect(s.out.join('')).toContain('added 3, updated 0, skipped 0, failed 0');
    // The Google token is never read without --docs, and Jira's is never sent to slop.
    expect(JSON.stringify(s.posts)).not.toContain('tok');
  });

  it('counts added, updated, skipped and failed from slop, and lists the failures', async () => {
    const s = setup({
      pages: [[issue(1), issue(2), issue(3), issue(4)]],
      results: (k) => {
        const known: Record<string, 'added' | 'updated' | 'skipped'> = { 'APP-1': 'added', 'APP-2': 'updated', 'APP-3': 'skipped' };
        return known[k] ?? { failed: 'too odd' };
      },
    });
    await importCommand(['jira', '--board', '1', '--project', 'APP', '--since', '2025-01-31'], s.deps);
    const text = s.out.join('');
    expect(text).toContain('added 1, updated 1, skipped 1, failed 1');
    expect(text).toContain('APP-4: too odd');
    expect(s.requests[0]?.url).toContain(new URLSearchParams({ q: 'updated >= "2025-01-31"' }).toString().slice(2));
  });

  it('batches at 50 items', async () => {
    const issues = Array.from({ length: 120 }, (_, i) => issue(i + 1));
    const s = setup({ pages: [issues] });
    await importCommand(['jira', '--board', '1', '--project', 'APP'], s.deps);
    expect(s.posts.map((p) => p.items.length)).toEqual([50, 50, 20]);
  });

  it('with --docs collects Docs from the text and web links, fetches each once and lists those it cannot', async () => {
    const withLink = issue(1, { description: adf(`Design: ${doc(DOC_A)}`) });
    const s = setup({
      pages: [[withLink, issue(2)]],
      remote: { 'APP-2': [doc(DOC_B), doc(DOC_A)] },
      docs: { [DOC_B]: 403 },
    });
    await importCommand(['jira', '--board', '1', '--project', 'APP', '--docs'], s.deps);
    const items = s.posts.flatMap((p) => p.items);
    expect(items.filter((i) => i.source === 'gdoc').map((i) => i.sourceKey)).toEqual([DOC_A]);
    expect(items.find((i) => i.source === 'gdoc')?.text).toBe('Design notes\n\nDoc body text');
    expect(s.requests.filter((r) => r.url.includes(`/files/${DOC_A}/export`))).toHaveLength(1);
    expect(s.requests.find((r) => r.url.includes('/export'))?.auth).toBe('Bearer gtok');
    const text = s.out.join('');
    expect(text).toContain(`Google Docs not fetched (1)`);
    expect(text).toContain(`${DOC_B} (linked from APP-2): Drive answered 403`);
    expect(text).toContain('failed 0');
  });

  it('does not touch Drive or web links without --docs', async () => {
    const s = setup({ pages: [[issue(1, { description: adf(doc(DOC_A)) })]] });
    await importCommand(['jira', '--board', '1', '--project', 'APP'], s.deps);
    expect(s.requests.some((r) => r.url.includes('googleapis') || r.url.includes('remotelink'))).toBe(false);
  });

  it('refuses bad arguments and missing credentials before any request', async () => {
    const s = setup({ pages: [], env: { JIRA_API_TOKEN: '' } });
    await expect(importCommand(['jira', '--project', 'APP'], s.deps)).rejects.toBeInstanceOf(UsageError);
    await expect(importCommand(['jira', '--board', '1'], s.deps)).rejects.toBeInstanceOf(UsageError);
    await expect(importCommand(['jira', '--board', '1', '--project', 'APP', '--since', 'last week'], s.deps)).rejects.toBeInstanceOf(UsageError);
    await expect(importCommand(['confluence', '--board', '1'], s.deps)).rejects.toBeInstanceOf(UsageError);
    await expect(importCommand(['jira', '--board', '1', '--project', 'APP'], s.deps)).rejects.toThrow(/JIRA_API_TOKEN/);
    const noGoogle = setup({ pages: [], env: { GOOGLE_ACCESS_TOKEN: '' } });
    await expect(importCommand(['jira', '--board', '1', '--project', 'APP', '--docs'], noGoogle.deps)).rejects.toThrow(SlopError);
    expect(s.requests).toEqual([]);
  });
});
