import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CheckoutPaths, writeFileAtomic } from './checkout-paths.js';
import type { Settings } from './config.js';
import { SlopError, UsageError } from './errors.js';
import { HTTP_TIMEOUT_MS, type Fetch } from './http.js';
import { describeError, parseJsonOrUndefined } from './util.js';

export const MANIFEST_PATH = '.claude/slop-agent-set.json';
export const MARKER = '<!-- implementation-agent-system -->';
export const MARKER_END = '<!-- /implementation-agent-system -->';
export const DEFAULT_MCP_SERVER = 'slop';
/** The board's local-run spec, for sstor; gitignored and not in the manifest. */
export const LOCAL_RUN_PATH = '.sstor/local-run.json';
const CLAUDE_MCP_TIMEOUT_MS = 15_000;

/** Files the Jira-era agent system installed; removed on the first run. */
export const LEGACY_FILES = [
  '.claude/agents/qa.md',
  '.claude/agents/unit_test_writer.md',
  '.claude/commands/run-task.md',
  '.claude/commands/deploy.sh',
  '.claude/skills/run-task.md',
  '.claude/skills/deploy.sh',
  '.claude/memory/workflow_config.md',
] as const;
export const LEGACY_DIRS = ['.claude/agents/docs'] as const;

const MANAGED_PREFIXES = ['agents/', 'commands/', 'hooks/'] as const;

/** A relative path with no `..` or empty segments, so writing it can't leave its folder. */
function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** One shell command line, as slop checks it (`domain/local-run.ts` in core): sstor runs it. */
const localRunCommand = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((command) => !/[\0\r\n]/.test(command), 'one line');

const bundleSchema = z.object({
  version: z.number().int(),
  files: z.array(
    z.object({
      path: z.string().refine(isSafeRelativePath, 'unsafe path'),
      content: z.string(),
    }),
  ),
  /** Absent from older servers (the installed file is left alone); null when the board has none. */
  localRun: z.strictObject({ build: localRunCommand.optional(), launch: localRunCommand }).nullable().optional(),
  /** Why slop isn't serving the board's stored spec (it fails slop's check). */
  localRunProblem: z.string().optional(),
});
export type AgentSetBundle = z.infer<typeof bundleSchema>;

const downloadLinkSchema = z.object({ url: z.url() });

const manifestSchema = z.object({ files: z.array(z.string()) });

/** The part of SlopClient init uses; tests inject a fake. */
export interface ToolCaller {
  call(tool: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface SlopConnection {
  readonly client: ToolCaller;
  /** slop's base URL; download links must be https or on its origin. */
  readonly slopUrl: string;
}

export interface InitDeps {
  /** The git checkout's root. */
  readonly root: string;
  readonly board: string;
  /** The MCP server name the developer may already have configured. */
  readonly server: string;
  /** Builds the slop client; called inside the fallback, so config errors keep the installed copy. */
  readonly connect: () => SlopConnection;
  readonly fetch: Fetch;
  /** Whether `claude mcp get <server>` finds the server; then .mcp.json is left alone. */
  readonly isMcpServerConfigured: (server: string, root: string) => Promise<boolean>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly stdout: (text: string) => void;
}

/** The board from the argument, then SLOP_BOARD (environment, then the config files). */
export function resolveBoard(argument: string | undefined, settings: Settings): string {
  const board = argument !== undefined && argument !== '' ? argument : settings.SLOP_BOARD;
  if (board === undefined || !/^\d+$/.test(board)) {
    throw new UsageError(
      'no board: pass one (slop init <board>), set SLOP_BOARD, or add SLOP_BOARD to .sstor/sstor.conf',
    );
  }
  return board;
}

/** slop's download links are https, or on slop's own origin (a local dev server). */
function isTrustedDownload(url: string, slopUrl: string): boolean {
  const link = new URL(url);
  return (
    link.protocol === 'https:' || (URL.canParse(slopUrl) && link.origin === new URL(slopUrl).origin)
  );
}

/** Asks slop for a short-lived download link and fetches the agent set bundle from it. */
export async function fetchAgentSet(
  connection: SlopConnection,
  fetch: Fetch,
  board: string,
): Promise<AgentSetBundle> {
  const link = downloadLinkSchema.safeParse(
    await connection.client.call('get_agent_set', { board: Number(board), download: true }),
  );
  if (!link.success) throw new SlopError('get_agent_set: slop returned no download link');
  if (!isTrustedDownload(link.data.url, connection.slopUrl)) {
    throw new SlopError("get_agent_set: the download link is neither https nor on slop's origin");
  }
  let body: unknown;
  try {
    const response = await fetch(link.data.url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) throw new SlopError(`download failed: HTTP ${response.status}`);
    body = parseJsonOrUndefined(await response.text());
  } catch (error) {
    if (error instanceof SlopError) throw error;
    throw new SlopError(`could not download the agent set: ${describeError(error)}`);
  }
  const bundle = bundleSchema.safeParse(body);
  if (!bundle.success) throw new SlopError('slop returned an unexpected agent set bundle');
  return bundle.data;
}

/** Runs `slop init`: installs the board's agent set, or keeps the installed copy if slop is down. */
export async function runInit(deps: InitDeps): Promise<void> {
  let bundle: AgentSetBundle;
  try {
    // Connecting inside the try: a missing SLOP_URL falls back like an unreachable slop.
    bundle = await fetchAgentSet(deps.connect(), deps.fetch, deps.board);
  } catch (error) {
    if ((await readText(join(deps.root, MANIFEST_PATH))) !== undefined) {
      deps.log(
        `slop init: warning: could not fetch the agent set from slop (${describeError(error)}); keeping the installed copy`,
      );
      return;
    }
    throw new SlopError(
      `could not fetch the agent set from slop and nothing is installed yet: ${describeError(error)}`,
    );
  }
  const written = await installAgentSet(deps, bundle);
  deps.stdout(
    `slop init: board ${deps.board} agent set v${bundle.version}: ${written.length} files, settings, CLAUDE.md${localRunSummary(bundle)}\n`,
  );
}

function localRunSummary(bundle: AgentSetBundle): string {
  if (bundle.localRunProblem !== undefined || bundle.localRun === undefined) return '';
  return bundle.localRun === null ? ', no local-run spec' : `, local-run spec (${LOCAL_RUN_PATH})`;
}

/** The spec's canonical text, as slop stores it: build first, two-space JSON. */
function renderLocalRun(spec: NonNullable<AgentSetBundle['localRun']>): string {
  const ordered = spec.build === undefined ? { launch: spec.launch } : { build: spec.build, launch: spec.launch };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

type InstallDeps = Pick<
  InitDeps,
  'root' | 'board' | 'server' | 'isMcpServerConfigured' | 'now' | 'log'
>;

interface PendingWrite {
  readonly relative: string;
  readonly content: string;
}

const STAGING_PREFIX = '.slop-staging-';

/**
 * Writes the bundle into the checkout and returns the managed files written. Everything is
 * parsed and every destination checked before the first write.
 */
export async function installAgentSet(
  deps: InstallDeps,
  bundle: AgentSetBundle,
): Promise<string[]> {
  const paths = await CheckoutPaths.open(deps.root);
  const claudeFolder = await paths.folder('.claude');
  await removeOldStaging(claudeFolder);

  const managed = bundle.files.flatMap((file) => {
    const target = targetOf(file.path);
    return target === undefined ? [] : [{ relative: target, content: file.content }];
  });
  const written = managed.map((file) => file.relative);
  const byPath = new Map(bundle.files.map((file) => [file.path, file.content]));
  const incomingSettings = optionalJsonObject(byPath.get('settings.json'), 'settings.json');
  const incomingMcp = optionalJsonObject(byPath.get('mcp.json'), 'mcp.json');
  const section = byPath.get('claude_md.md');
  // A spec slop couldn't serve leaves the installed one alone, as an older server's bundle does.
  if (bundle.localRunProblem !== undefined) {
    deps.log(
      `slop init: warning: the board's local-run spec in slop is invalid (${bundle.localRunProblem}); keeping ${LOCAL_RUN_PATH} as it is, so sessions launch the previous spec. A board admin should fix it on the Knowledge page.`,
    );
  }
  const localRun = bundle.localRunProblem === undefined ? bundle.localRun : undefined;

  // Resolve every destination first: one outside the checkout stops the run before any write.
  const destinations = new Map<string, string>();
  for (const relative of [
    ...written,
    '.claude/settings.json',
    '.mcp.json',
    'CLAUDE.md',
    '.gitignore',
    MANIFEST_PATH,
    ...(localRun === undefined || localRun === null ? [] : [LOCAL_RUN_PATH]),
  ]) {
    destinations.set(relative, await paths.writable(relative));
  }
  const destination = (relative: string): string => {
    const path = destinations.get(relative);
    if (path === undefined) throw new Error(`no destination resolved for ${relative}`);
    return path;
  };

  const previous = await readManifest(destination(MANIFEST_PATH));
  const isFirstRun = previous === undefined;
  const pending: PendingWrite[] = [];
  if (incomingSettings !== undefined) {
    const current = await readJsonObject(destination('.claude/settings.json'));
    pending.push(
      jsonWrite('.claude/settings.json', mergeSettings(current, incomingSettings, isFirstRun)),
    );
  }
  if (incomingMcp !== undefined && !(await deps.isMcpServerConfigured(deps.server, deps.root))) {
    const current = await readJsonObject(destination('.mcp.json'));
    pending.push(jsonWrite('.mcp.json', mergeMcp(current, incomingMcp)));
  }
  if (section !== undefined) {
    const current = (await readText(destination('CLAUDE.md'))) ?? '';
    pending.push({ relative: 'CLAUDE.md', content: replaceClaudeMdSection(current, section) });
  }
  const gitignore = (await readText(destination('.gitignore'))) ?? '';
  const ignored = ['.reviews/', LOCAL_RUN_PATH].reduce((text, line) => ensureLine(text, line) ?? text, gitignore);
  if (ignored !== gitignore) pending.push({ relative: '.gitignore', content: ignored });
  if (localRun !== undefined && localRun !== null) {
    pending.push({ relative: LOCAL_RUN_PATH, content: renderLocalRun(localRun) });
  }

  await swapInManagedFiles(claudeFolder, managed, destination);
  for (const write of pending) await writeFileAtomic(destination(write.relative), write.content);

  // Remove managed files that left the agent set, and on the first run the legacy ones the
  // bundle didn't just write.
  const removals = (previous ?? [])
    .filter((path) => !written.includes(path) && isManagedTarget(path))
    .map((path) => ({ path, isFolder: false }));
  if (isFirstRun) {
    for (const path of LEGACY_FILES) {
      if (!written.includes(path)) removals.push({ path, isFolder: false });
    }
    for (const folder of LEGACY_DIRS) {
      if (!written.some((path) => path.startsWith(`${folder}/`))) {
        removals.push({ path: folder, isFolder: true });
      }
    }
  }
  // The board has no spec (any more): sstor then has nothing to run.
  if (localRun === null) removals.push({ path: LOCAL_RUN_PATH, isFolder: false });
  for (const { path, isFolder } of removals.sort((a, b) => a.path.localeCompare(b.path))) {
    const removal = await paths.removal(path);
    if (removal.kind === 'outside') {
      deps.log(`slop init: warning: not removing ${path}: it resolves outside the git checkout`);
    } else if (removal.kind === 'remove') {
      await rm(removal.path, { force: true, recursive: isFolder });
    }
  }

  const manifest = {
    board: Number(deps.board),
    version: bundle.version,
    files: [...written].sort(),
    fetchedAt: new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  await writeFileAtomic(destination(MANIFEST_PATH), jsonWrite(MANIFEST_PATH, manifest).content);
  return written;
}

/** Where a bundle file goes in the checkout; files that are merged instead return undefined. */
function targetOf(path: string): string | undefined {
  return MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? `.claude/${path}` : undefined;
}

/** Only files init could have written are removed, whatever an edited manifest lists. */
function isManagedTarget(path: string): boolean {
  return (
    isSafeRelativePath(path) &&
    MANAGED_PREFIXES.some((prefix) => path.startsWith(`.claude/${prefix}`))
  );
}

/** Staging folders a crashed run left behind. */
async function removeOldStaging(claudeFolder: string): Promise<void> {
  for (const name of await readdir(claudeFolder)) {
    if (name.startsWith(STAGING_PREFIX)) {
      await rm(join(claudeFolder, name), { recursive: true, force: true });
    }
  }
}

/** Stages every managed file first and swaps them in only when all are written. */
async function swapInManagedFiles(
  claudeFolder: string,
  files: readonly PendingWrite[],
  destination: (relative: string) => string,
): Promise<void> {
  // The staging folder sits inside the checkout so the renames never cross filesystems.
  const staging = await mkdtemp(join(claudeFolder, STAGING_PREFIX));
  try {
    for (const [index, file] of files.entries()) {
      await writeFile(join(staging, String(index)), file.content);
    }
    for (const [index, file] of files.entries()) {
      const target = destination(file.relative);
      await rename(join(staging, String(index)), target);
      if (file.relative.startsWith('.claude/hooks/')) await chmod(target, 0o755);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Merging

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectAt(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (isJsonObject(value)) return value;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function sortedUnion(...lists: readonly string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

/**
 * Combines lists as a union (sorted when every item is a string) and recurses into objects;
 * any other value is set only where `current` lacks it, so the developer's choices stand.
 */
export function mergeMissing(current: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];
    if (existing === undefined) {
      merged[key] = structuredClone(value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = unionList(existing, value);
    } else if (isJsonObject(existing) && isJsonObject(value)) {
      merged[key] = mergeMissing(existing, value);
    }
  }
  return merged;
}

function unionList(current: readonly unknown[], incoming: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const items: unknown[] = [];
  for (const item of [...current, ...incoming]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  const strings = items.filter((item): item is string => typeof item === 'string');
  return strings.length === items.length ? strings.sort() : items;
}

function hookCommands(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) =>
    isJsonObject(group) && Array.isArray(group.hooks)
      ? group.hooks.flatMap((hook) =>
          isJsonObject(hook) && typeof hook.command === 'string' ? [hook.command] : [],
        )
      : [],
  );
}

/** Merges the agent set's settings.json into the checkout's `.claude/settings.json`. */
export function mergeSettings(
  currentSettings: JsonObject,
  incoming: JsonObject,
  isFirstRun: boolean,
): JsonObject {
  const current = structuredClone(currentSettings);
  if (isFirstRun) removeAtlassian(current);

  if (isJsonObject(incoming.env)) {
    Object.assign(objectAt(current, 'env'), incoming.env);
  }

  const incomingPermissions = isJsonObject(incoming.permissions) ? incoming.permissions : {};
  const permissions = objectAt(current, 'permissions');
  for (const kind of ['allow', 'deny'] as const) {
    const merged = sortedUnion(
      stringList(permissions[kind]),
      stringList(incomingPermissions[kind]),
    );
    if (merged.length > 0) permissions[kind] = merged;
  }

  if (isJsonObject(incoming.sandbox)) {
    current.sandbox = mergeMissing(
      isJsonObject(current.sandbox) ? current.sandbox : {},
      incoming.sandbox,
    );
  }

  const servers = sortedUnion(
    stringList(current.enabledMcpjsonServers),
    stringList(incoming.enabledMcpjsonServers),
  );
  if (servers.length > 0) current.enabledMcpjsonServers = servers;

  if (isJsonObject(incoming.hooks)) {
    const hooks = objectAt(current, 'hooks');
    for (const [event, groups] of Object.entries(incoming.hooks)) {
      if (!Array.isArray(groups)) continue;
      const existing: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
      hooks[event] = existing;
      const commands = new Set(hookCommands(existing));
      for (const group of groups) {
        if (hookCommands([group]).some((command) => commands.has(command))) continue;
        existing.push(structuredClone(group));
        for (const command of hookCommands([group])) commands.add(command);
      }
    }
  }
  return current;
}

/** The Jira-era entries, removed on the first run. */
function removeAtlassian(settings: JsonObject): void {
  if (isJsonObject(settings.mcpServers)) {
    delete settings.mcpServers['atlassian-rovo'];
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }
  if (isJsonObject(settings.env)) delete settings.env.TASK_APP_URL;
  if (isJsonObject(settings.permissions) && Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = settings.permissions.allow.filter(
      (permission) => !(typeof permission === 'string' && permission.startsWith('mcp__atlassian')),
    );
  }
}

/** Adds the agent set's MCP servers to `.mcp.json`; incoming entries win. */
export function mergeMcp(currentConfig: JsonObject, incoming: JsonObject): JsonObject {
  const current = structuredClone(currentConfig);
  if (isJsonObject(incoming.mcpServers)) {
    Object.assign(objectAt(current, 'mcpServers'), structuredClone(incoming.mcpServers));
  }
  return current;
}

/** Replaces the marked agent-system section of CLAUDE.md, or appends it. */
export function replaceClaudeMdSection(text: string, section: string): string {
  const block = `${MARKER}\n${section.trim()}\n${MARKER_END}`;
  const start = text.indexOf(MARKER);
  const end = start < 0 ? -1 : text.indexOf(MARKER_END, start);
  if (start >= 0 && end >= 0) {
    return text.slice(0, start) + block + text.slice(end + MARKER_END.length);
  }
  return (text.trim() === '' ? '' : `${text.trimEnd()}\n\n`) + block + '\n';
}

/** The file text with `line` added, or undefined when it is already there. */
export function ensureLine(text: string, line: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines.includes(line)) return undefined;
  const kept = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  return [...kept, line].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Files

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseJsonObject(text: string, what: string): JsonObject {
  const value = parseJsonOrUndefined(text);
  if (!isJsonObject(value)) throw new SlopError(`${what} is not a JSON object`);
  return value;
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const text = await readText(path);
  return text === undefined ? {} : parseJsonObject(text, path);
}

async function readManifest(path: string): Promise<string[] | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const manifest = manifestSchema.safeParse(parseJsonOrUndefined(text));
  if (!manifest.success) {
    throw new SlopError(
      `${path} is not a valid agent set manifest: delete it and run slop init again`,
    );
  }
  return manifest.data.files;
}

function jsonWrite(relative: string, value: unknown): PendingWrite {
  return { relative, content: `${JSON.stringify(value, null, 2)}\n` };
}

function optionalJsonObject(text: string | undefined, name: string): JsonObject | undefined {
  return text === undefined ? undefined : parseJsonObject(text, `the agent set's ${name}`);
}

// ---------------------------------------------------------------------------
// The developer's own MCP config

const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** slop's MCP server name from SLOP_MCP_SERVER, or `slop`; one `claude` could read as a flag is refused. */
export function resolveMcpServer(settings: Settings): string {
  const server = settings.SLOP_MCP_SERVER ?? DEFAULT_MCP_SERVER;
  if (!SERVER_NAME.test(server)) {
    throw new SlopError(`SLOP_MCP_SERVER '${server}' is not a valid MCP server name`);
  }
  return server;
}

/** `claude mcp get <server>` succeeds; a missing `claude`, an error or a timeout count as no. */
export function claudeHasMcpServer(server: string, root: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!SERVER_NAME.test(server)) {
      resolve(false);
      return;
    }
    execFile(
      'claude',
      ['mcp', 'get', server],
      { cwd: root, timeout: CLAUDE_MCP_TIMEOUT_MS },
      (error) => {
        resolve(error === null);
      },
    );
  });
}
