import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlopError, UsageError } from '../src/errors.js';
import type { Fetch } from '../src/http.js';
import {
  MANIFEST_PATH,
  MARKER,
  MARKER_END,
  mergeSettings,
  replaceClaudeMdSection,
  resolveBoard,
  runInit,
  type AgentSetBundle,
  type InitDeps,
  type ToolCaller,
} from '../src/init.js';
import { EXIT_OK, EXIT_USAGE, main, type CliContext } from '../src/main.js';
import { MemoryTokenStore } from './support.js';

const DOWNLOAD_URL = 'https://slop.test/downloads/agent-set/7?expires=1&signature=x';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const SETTINGS = {
  env: { SLOP_BOARD: '7' },
  permissions: { allow: ['mcp__slop__get_glob', 'Bash(git status:*)'], deny: ['Read(./.env)'] },
  sandbox: {
    enabled: true,
    network: { allowedDomains: ['github.com', 'registry.npmjs.org'] },
  },
  enabledMcpjsonServers: ['slop'],
  hooks: {
    PostToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '.claude/hooks/slop_after_push.sh' }],
      },
    ],
  },
};

const MCP = { mcpServers: { slop: { type: 'http', url: 'https://slop.test/mcp' } } };

function bundle(overrides: Partial<Record<string, string>> = {}, version = 3): AgentSetBundle {
  const files: Record<string, string> = {
    'agents/implementer.md': '# Implementer\n',
    'agents/tester.md': '# Tester\n',
    'commands/run-glob.md': '# run-glob\n',
    'hooks/slop_after_push.sh': '#!/bin/sh\necho pushed\n',
    'settings.json': JSON.stringify(SETTINGS),
    'mcp.json': JSON.stringify(MCP),
    'claude_md.md': '# Slop agent system\n\nRules.\n',
  };
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined) Reflect.deleteProperty(files, path);
    else files[path] = content;
  }
  return { version, files: Object.entries(files).map(([path, content]) => ({ path, content })) };
}

interface Harness {
  readonly deps: InitDeps;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { tool: string; args: unknown }[];
}

describe('slop init', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'slop-init-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function harness(
    options: {
      body?: unknown;
      clientError?: Error;
      downloadUrl?: string;
      mcpConfigured?: boolean;
    } = {},
  ): Harness {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { tool: string; args: unknown }[] = [];
    const client: ToolCaller = {
      call: (tool, args) => {
        calls.push({ tool, args });
        if (options.clientError !== undefined) return Promise.reject(options.clientError);
        return Promise.resolve({
          version: 3,
          url: options.downloadUrl ?? DOWNLOAD_URL,
          expiresAt: 'x',
        });
      },
    };
    const fetch: Fetch = (input) =>
      input === (options.downloadUrl ?? DOWNLOAD_URL)
        ? Promise.resolve(Response.json(options.body ?? bundle()))
        : Promise.reject(new Error(`unexpected request to ${input}`));
    return {
      out,
      err,
      calls,
      deps: {
        root,
        board: '7',
        server: 'slop',
        connect: () => ({ client, slopUrl: 'https://slop.test' }),
        fetch,
        isMcpServerConfigured: () => Promise.resolve(options.mcpConfigured ?? false),
        now: () => NOW,
        log: (message) => err.push(message),
        stdout: (text) => out.push(text),
      },
    };
  }

  const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await read(path));
  const exists = (path: string): Promise<boolean> =>
    stat(join(root, path)).then(
      () => true,
      () => false,
    );
  async function put(path: string, content: string): Promise<void> {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  it('installs the agent set into a fresh checkout', async () => {
    const run = harness();
    await runInit(run.deps);

    expect(run.calls).toEqual([{ tool: 'get_agent_set', args: { board: 7, download: true } }]);
    expect(await read('.claude/agents/implementer.md')).toBe('# Implementer\n');
    expect(await read('.claude/commands/run-glob.md')).toBe('# run-glob\n');
    expect((await stat(join(root, '.claude/hooks/slop_after_push.sh'))).mode & 0o777).toBe(0o755);
    expect(await readJson('.claude/settings.json')).toEqual({
      ...SETTINGS,
      permissions: {
        allow: ['Bash(git status:*)', 'mcp__slop__get_glob'],
        deny: ['Read(./.env)'],
      },
    });
    expect(await readJson('.mcp.json')).toEqual(MCP);
    expect(await read('CLAUDE.md')).toBe(
      `${MARKER}\n# Slop agent system\n\nRules.\n${MARKER_END}\n`,
    );
    expect(await read('.gitignore')).toBe('.reviews/\n');
    expect(await readJson(MANIFEST_PATH)).toEqual({
      board: 7,
      version: 3,
      files: [
        '.claude/agents/implementer.md',
        '.claude/agents/tester.md',
        '.claude/commands/run-glob.md',
        '.claude/hooks/slop_after_push.sh',
      ],
      fetchedAt: '2026-10-04T12:00:00Z',
    });
    expect(
      (await readdir(join(root, '.claude'))).filter((name) => name.startsWith('.slop')),
    ).toEqual([]);
    expect(run.out).toEqual(['slop init: board 7 agent set v3: 4 files, settings, CLAUDE.md\n']);
  });

  it('is idempotent when run again', async () => {
    await put('.gitignore', 'node_modules\n');
    await put('CLAUDE.md', '# Project\n');
    await runInit(harness().deps);
    const paths = ['.claude/settings.json', '.mcp.json', 'CLAUDE.md', '.gitignore', MANIFEST_PATH];
    const first = await Promise.all(paths.map(read));
    await runInit(harness().deps);
    expect(await Promise.all(paths.map(read))).toEqual(first);
    expect(await read('.gitignore')).toBe('node_modules\n.reviews/\n');
  });

  it('merges sandbox lists into an existing sandbox block, keeping the developer settings', async () => {
    await put(
      '.claude/settings.json',
      JSON.stringify({
        sandbox: {
          enabled: false,
          network: {
            allowedDomains: ['example.com', 'registry.npmjs.org'],
            allowLocalBinding: true,
          },
        },
      }),
    );
    await runInit(harness().deps);
    const settings = await readJson('.claude/settings.json');
    expect(settings).toMatchObject({
      sandbox: {
        enabled: false,
        network: {
          allowedDomains: ['example.com', 'github.com', 'registry.npmjs.org'],
          allowLocalBinding: true,
        },
      },
    });
  });

  it('dedupes permissions and hooks against what is already there', async () => {
    await put(
      '.claude/settings.json',
      JSON.stringify({
        env: { SLOP_BOARD: '1', OTHER: 'x' },
        permissions: { allow: ['mcp__slop__get_glob', 'Bash(ls:*)'] },
        hooks: {
          PostToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: '.claude/hooks/slop_after_push.sh' }],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        },
      }),
    );
    await runInit(harness().deps);
    expect(await readJson('.claude/settings.json')).toMatchObject({
      env: { SLOP_BOARD: '7', OTHER: 'x' },
      permissions: {
        allow: ['Bash(git status:*)', 'Bash(ls:*)', 'mcp__slop__get_glob'],
        deny: ['Read(./.env)'],
      },
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '.claude/hooks/slop_after_push.sh' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    });
  });

  it('replaces the CLAUDE.md section between the markers, or appends it', async () => {
    const existing = `# Project\n\n${MARKER}\nold rules\n${MARKER_END}\n\n## More\n`;
    expect(replaceClaudeMdSection(existing, 'new rules\n')).toBe(
      `# Project\n\n${MARKER}\nnew rules\n${MARKER_END}\n\n## More\n`,
    );
    expect(replaceClaudeMdSection('# Project\n\n', 'new rules')).toBe(
      `# Project\n\n${MARKER}\nnew rules\n${MARKER_END}\n`,
    );
    await put('CLAUDE.md', existing);
    await runInit(harness().deps);
    expect(await read('CLAUDE.md')).toBe(
      `# Project\n\n${MARKER}\n# Slop agent system\n\nRules.\n${MARKER_END}\n\n## More\n`,
    );
  });

  it('removes files that left the agent set, but nothing outside the managed folders', async () => {
    await runInit(harness().deps);
    await put('.claude/agents/mine.md', 'mine');
    // A hand-edited manifest listing files outside the managed folders.
    await put(
      MANIFEST_PATH,
      JSON.stringify({
        board: 7,
        version: 3,
        files: [
          '.claude/agents/implementer.md',
          '.claude/agents/tester.md',
          'CLAUDE.md',
          '.claude/../x',
        ],
      }),
    );
    await put('x', 'outside');
    await runInit(harness({ body: bundle({ 'agents/tester.md': undefined }, 4) }).deps);
    expect(await exists('.claude/agents/tester.md')).toBe(false);
    expect(await exists('.claude/agents/implementer.md')).toBe(true);
    expect(await exists('.claude/agents/mine.md')).toBe(true);
    expect(await exists('CLAUDE.md')).toBe(true);
    expect(await exists('x')).toBe(true);
    expect(await readJson(MANIFEST_PATH)).toMatchObject({ version: 4 });
  });

  it('cleans up the legacy files and Atlassian entries on the first run only', async () => {
    await put('.claude/agents/qa.md', 'legacy');
    await put('.claude/commands/run-task.md', 'legacy');
    await put('.claude/agents/docs/guide.md', 'legacy');
    await put(
      '.claude/settings.json',
      JSON.stringify({
        mcpServers: { 'atlassian-rovo': { url: 'x' } },
        env: { TASK_APP_URL: 'x' },
        permissions: { allow: ['mcp__atlassian__search', 'Bash(ls:*)'] },
      }),
    );
    await runInit(harness().deps);
    expect(await exists('.claude/agents/qa.md')).toBe(false);
    expect(await exists('.claude/commands/run-task.md')).toBe(false);
    expect(await exists('.claude/agents/docs')).toBe(false);
    const settings = await readJson('.claude/settings.json');
    expect(settings).not.toHaveProperty('mcpServers');
    expect(settings).toMatchObject({ env: { SLOP_BOARD: '7' } });
    expect(settings).not.toHaveProperty('env.TASK_APP_URL');
    expect(settings).toMatchObject({
      permissions: { allow: ['Bash(git status:*)', 'Bash(ls:*)', 'mcp__slop__get_glob'] },
    });

    // Not the first run any more: a file with a legacy name is left alone.
    await put('.claude/agents/qa.md', 'now mine');
    await runInit(harness().deps);
    expect(await exists('.claude/agents/qa.md')).toBe(true);
  });

  it('keeps .mcp.json untouched when the developer already has the server', async () => {
    await runInit(harness({ mcpConfigured: true }).deps);
    expect(await exists('.mcp.json')).toBe(false);
  });

  it('keeps the installed copy when slop is unreachable and a manifest exists', async () => {
    await runInit(harness().deps);
    const before = await read(MANIFEST_PATH);
    const run = harness({ clientError: new SlopError('could not reach https://slop.test/mcp') });
    await runInit(run.deps);
    expect(run.err.join('')).toContain('warning: could not fetch the agent set');
    expect(run.out).toEqual([]);
    expect(await read(MANIFEST_PATH)).toBe(before);
  });

  it('fails when slop is unreachable and nothing is installed', async () => {
    const run = harness({ clientError: new SlopError('could not reach https://slop.test/mcp') });
    await expect(runInit(run.deps)).rejects.toThrow('nothing is installed yet');
    expect(await exists(MANIFEST_PATH)).toBe(false);
  });

  it('rejects an invalid bundle', async () => {
    await expect(runInit(harness({ body: { version: 3 } }).deps)).rejects.toThrow(
      'unexpected agent set bundle',
    );
    const traversal = { version: 3, files: [{ path: 'agents/../../evil.sh', content: 'x' }] };
    await expect(runInit(harness({ body: traversal }).deps)).rejects.toThrow(
      'unexpected agent set bundle',
    );
    expect(await exists(MANIFEST_PATH)).toBe(false);
  });

  it("rejects a download link that is neither https nor on slop's origin", async () => {
    const run = harness({ downloadUrl: 'http://elsewhere.test/bundle.json' });
    await expect(runInit(run.deps)).rejects.toThrow('neither https nor on slop');
  });

  it('changes nothing when an existing settings file is not JSON', async () => {
    await put('.claude/settings.json', 'not json');
    await expect(runInit(harness().deps)).rejects.toThrow('is not a JSON object');
    expect(await exists('.claude/agents/implementer.md')).toBe(false);
    expect(await exists('CLAUDE.md')).toBe(false);
    expect(await read('.claude/settings.json')).toBe('not json');
  });

  it('removes staging folders a crashed run left behind', async () => {
    await put('.claude/.slop-staging-old/0', 'leftover');
    await runInit(harness().deps);
    expect(await exists('.claude/.slop-staging-old')).toBe(false);
  });

  it('keeps legacy-named files the bundle itself ships on the first run', async () => {
    await runInit(
      harness({ body: bundle({ 'agents/qa.md': '# QA\n', 'agents/docs/a.md': 'a' }) }).deps,
    );
    expect(await read('.claude/agents/qa.md')).toBe('# QA\n');
    expect(await read('.claude/agents/docs/a.md')).toBe('a');
  });

  describe('symlinks', () => {
    let outside: string;

    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), 'slop-init-outside-'));
    });

    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    it('refuses to write through a managed folder linked outside the checkout', async () => {
      await mkdir(join(root, '.claude'));
      await symlink(outside, join(root, '.claude/agents'));
      await expect(runInit(harness().deps)).rejects.toThrow('outside the git checkout');
      expect(await readdir(outside)).toEqual([]);
      expect(await exists('.claude/commands/run-glob.md')).toBe(false);
      expect(await exists('.claude/settings.json')).toBe(false);
      expect(await exists(MANIFEST_PATH)).toBe(false);
    });

    it('refuses to write a merged file linked outside the checkout', async () => {
      await writeFile(join(outside, 'mcp.json'), '{}');
      await symlink(join(outside, 'mcp.json'), join(root, '.mcp.json'));
      await expect(runInit(harness().deps)).rejects.toThrow('refusing to write .mcp.json');
      expect(await readFile(join(outside, 'mcp.json'), 'utf8')).toBe('{}');
      expect(await exists('.claude/agents/implementer.md')).toBe(false);
    });

    it('skips stale removals through a link that leaves the checkout', async () => {
      await writeFile(join(outside, 'victim.md'), 'keep me');
      await mkdir(join(root, '.claude'));
      await symlink(outside, join(root, '.claude/agents'));
      await put(MANIFEST_PATH, JSON.stringify({ files: ['.claude/agents/victim.md'] }));
      const noAgents = bundle({
        'agents/implementer.md': undefined,
        'agents/tester.md': undefined,
      });
      const run = harness({ body: noAgents });
      await runInit(run.deps);
      expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('keep me');
      expect(run.err.join('')).toContain('not removing .claude/agents/victim.md');
    });

    it('skips the first-run legacy docs removal through a link', async () => {
      await writeFile(join(outside, 'guide.md'), 'keep me');
      await mkdir(join(root, '.claude/agents'), { recursive: true });
      await symlink(outside, join(root, '.claude/agents/docs'));
      const run = harness();
      await runInit(run.deps);
      expect(await readFile(join(outside, 'guide.md'), 'utf8')).toBe('keep me');
      expect(run.err.join('')).toContain('not removing .claude/agents/docs');
    });

    it('writes through a symlink that stays inside the checkout', async () => {
      await writeFile(join(root, 'AGENTS.md'), '# Project\n');
      await symlink('AGENTS.md', join(root, 'CLAUDE.md'));
      await runInit(harness().deps);
      expect((await lstat(join(root, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
      expect(await read('AGENTS.md')).toContain(`# Project\n\n${MARKER}`);
    });
  });
});

describe('mergeSettings', () => {
  it('adds missing sandbox values without overriding the developer scalars', () => {
    const merged = mergeSettings(
      { sandbox: { enabled: false, excludedCommands: ['docker'] } },
      { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, excludedCommands: ['git'] } },
      false,
    );
    expect(merged.sandbox).toEqual({
      enabled: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: ['docker', 'git'],
    });
  });
});

describe('resolveBoard', () => {
  it('takes the argument, then SLOP_BOARD, and rejects a missing or non-numeric board', () => {
    expect(resolveBoard('5', { SLOP_BOARD: '7' })).toBe('5');
    expect(resolveBoard(undefined, { SLOP_BOARD: '7' })).toBe('7');
    expect(() => resolveBoard(undefined, {})).toThrow(UsageError);
    expect(() => resolveBoard('abc', {})).toThrow(UsageError);
  });
});

describe('slop init command', () => {
  function context(gitRoot: string | undefined): { context: CliContext; err: string[] } {
    const err: string[] = [];
    return {
      err,
      context: {
        settings: { SLOP_URL: 'https://slop.test', SLOP_BOARD: '7' },
        store: new MemoryTokenStore(),
        fetch: () => Promise.reject(new Error('offline')),
        now: () => NOW,
        canPrompt: false,
        openBrowser: () => undefined,
        log: (message) => err.push(message),
        stdout: () => undefined,
        gitRoot: () => gitRoot,
        isMcpServerConfigured: () => Promise.resolve(false),
      },
    };
  }

  it('exits 2 for extra arguments and 1 outside a git checkout', async () => {
    expect(await main(['init', '1', '2'], context('/x').context)).toBe(EXIT_USAGE);
    const outside = context(undefined);
    expect(await main(['init'], outside.context)).toBe(1);
    expect(outside.err.join('')).toContain('inside a git checkout');
  });

  it('rejects a server name that claude could read as an option', async () => {
    const run = context('/x');
    const settings = { ...run.context.settings, SLOP_MCP_SERVER: '--help' };
    expect(await main(['init'], { ...run.context, settings })).toBe(1);
    expect(run.err.join('')).toContain('not a valid MCP server name');
  });

  it('keeps the installed copy and exits 0 when SLOP_URL is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-init-cmd-'));
    try {
      await mkdir(join(root, '.claude'));
      await writeFile(join(root, MANIFEST_PATH), JSON.stringify({ files: [] }));
      const run = context(root);
      const settings = { SLOP_BOARD: '7' };
      expect(await main(['init'], { ...run.context, settings })).toBe(EXIT_OK);
      expect(run.err.join('')).toContain('SLOP_URL is not set');
      expect(run.err.join('')).toContain('keeping the installed copy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the installed copy and exits 0 when not signed in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-init-cmd-'));
    try {
      await mkdir(join(root, '.claude'));
      await writeFile(join(root, MANIFEST_PATH), JSON.stringify({ files: [] }));
      const run = context(root);
      expect(await main(['init'], run.context)).toBe(EXIT_OK);
      expect(run.err.join('')).toContain('keeping the installed copy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
