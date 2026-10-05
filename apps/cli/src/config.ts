import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SlopError } from './errors.js';

/** The settings the CLI reads; the names are shared with sstor's config. */
export const SETTING_KEYS = [
  'SLOP_URL',
  'SLOP_CLIENT_ID',
  'SLOP_DEV_EMAIL',
  'SLOP_BOARD',
  'SLOP_MCP_SERVER',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type Settings = Readonly<Partial<Record<SettingKey, string>>>;

export interface ConfigSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The config files in precedence order, highest first. */
  readonly files: readonly string[];
  /** Returns the file's contents, or undefined when it doesn't exist. */
  readonly readFile: (path: string) => string | undefined;
}

export function userConfigPath(home: string = homedir()): string {
  return join(home, '.config', 'slop', 'config');
}

/** sstor's per-repo config, still read so existing checkouts keep working. */
export function repoConfigPath(gitRoot: string): string {
  return join(gitRoot, '.sstor', 'sstor.conf');
}

/** Parses KEY=VALUE lines; blank lines and # comments are skipped, surrounding quotes dropped. */
export function parseConfigFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const equals = line.indexOf('=');
    if (line === '' || line.startsWith('#') || equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line
      .slice(equals + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
    values[key] = value;
  }
  return values;
}

/** Each setting comes from the environment first, then the first config file that sets it. */
export function loadSettings(sources: ConfigSources): Settings {
  const fileValues = sources.files.map((path) => {
    const text = sources.readFile(path);
    return text === undefined ? {} : parseConfigFile(text);
  });
  const settings: Partial<Record<SettingKey, string>> = {};
  for (const key of SETTING_KEYS) {
    const candidates = [sources.env[key], ...fileValues.map((values) => values[key])];
    const value = candidates.find((candidate) => candidate !== undefined && candidate !== '');
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

export function requireSetting(settings: Settings, key: 'SLOP_URL' | 'SLOP_CLIENT_ID'): string {
  const value = settings[key];
  if (value === undefined) {
    throw new SlopError(`${key} is not set: export it or add it to ${userConfigPath()}`);
  }
  return value.replace(/\/+$/, '');
}

export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The enclosing git checkout's root, or undefined outside one. */
export function findGitRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root === '' ? undefined : root;
  } catch {
    // Not a git checkout, or git isn't installed: there is no repo config to read.
    return undefined;
  }
}

export function defaultConfigSources(): ConfigSources {
  const gitRoot = findGitRoot(process.cwd());
  return {
    env: process.env,
    files: [userConfigPath(), ...(gitRoot === undefined ? [] : [repoConfigPath(gitRoot)])],
    readFile: readFileIfExists,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A warning when SLOP_URL would send the bearer token in cleartext to another machine. */
export function insecureUrlWarning(settings: Settings): string | undefined {
  const value = settings.SLOP_URL;
  if (value === undefined || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (url.hostname.startsWith('127.')) return undefined;
  return `slop: warning: SLOP_URL ${url.origin} is not https; your slop login is sent unencrypted`;
}
