import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { accessToken, login, logout, type AuthDeps } from './auth.js';
import { SlopClient, type ToolArguments } from './client.js';
import { insecureUrlWarning, requireSetting, userConfigPath } from './config.js';
import { SlopError, UsageError } from './errors.js';
import type { Git } from './git.js';
import {
  GLOB_USAGE,
  MERGE_USAGE,
  NEW_USAGE,
  PICK_UP_USAGE,
  READY_USAGE,
  globCommand,
  mergeCommand,
  newCommand,
  pickUpCommand,
  readyCommand,
  type GlobDeps,
} from './globs.js';
import { PUT_ARTIFACT_USAGE, putArtifactCommand } from './put-artifact.js';
import { resolveBoard, resolveMcpServer, runInit } from './init.js';
import { describeError, parseJsonOrUndefined } from './util.js';

/** Everything a command needs from the outside world; bin.ts wires the real ones. */
export interface CliContext extends AuthDeps {
  readonly stdout: (text: string) => void;
  /** The enclosing git checkout's root, or undefined outside one. */
  readonly gitRoot: () => string | undefined;
  /** Whether the developer already has this MCP server configured in Claude Code. */
  readonly isMcpServerConfigured: (server: string, root: string) => Promise<boolean>;
  readonly git: Git;
  readonly sleep: (ms: number) => Promise<void>;
  /** Reads a file's text, or stdin for `-`; tests inject a fake. */
  readonly readInput?: (path: string) => Promise<string>;
}

async function readInputDefault(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

interface Command {
  readonly usage: string;
  readonly summary: string;
  readonly run: (args: readonly string[], context: CliContext) => Promise<void>;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

function clientFor(context: CliContext): SlopClient {
  return new SlopClient({
    slopUrl: requireSetting(context.settings, 'SLOP_URL'),
    fetch: context.fetch,
    accessToken: (forceRefresh) => accessToken(context, forceRefresh),
  });
}

function globDeps(context: CliContext): GlobDeps {
  return {
    client: clientFor(context),
    git: context.git,
    root: context.gitRoot(),
    settings: context.settings,
    stdout: context.stdout,
    log: context.log,
    now: context.now,
    sleep: context.sleep,
    newIdempotencyKey: randomUUID,
  };
}

function expectArgs(args: readonly string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new UsageError(`usage: slop ${usage}`);
}

const CALL_USAGE = "call <tool> ['<json arguments>']";
const API_USAGE = "api <GET|POST|PUT|PATCH|DELETE> </api/...> ['<json body>']";
const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const INIT_USAGE = 'init [board]';

const whoamiResultSchema = z.object({ email: z.string() });

const toolArgumentsSchema = z.record(z.string(), z.unknown());

function parseToolArguments(text: string | undefined): ToolArguments {
  if (text === undefined) return {};
  const parsed = toolArgumentsSchema.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) throw new UsageError('the tool arguments must be a JSON object');
  return parsed.data;
}

// New commands are added here.
const COMMANDS: Readonly<Record<string, Command>> = {
  login: {
    usage: 'login',
    summary: 'Sign in to slop through the browser',
    run: async (args, context) => {
      expectArgs(args, 0, 0, 'login');
      await login(context);
      context.log(`slop: signed in to ${requireSetting(context.settings, 'SLOP_URL')}`);
    },
  },
  logout: {
    usage: 'logout',
    summary: 'Forget the stored slop login',
    run: async (args, context) => {
      expectArgs(args, 0, 0, 'logout');
      await logout(context);
      context.log('slop: signed out');
    },
  },
  whoami: {
    usage: 'whoami',
    summary: 'Print the email of the signed-in person',
    run: async (args, context) => {
      expectArgs(args, 0, 0, 'whoami');
      const result = whoamiResultSchema.safeParse(await clientFor(context).call('whoami'));
      if (!result.success) throw new SlopError('whoami: unexpected response from slop');
      context.stdout(`${result.data.email}\n`);
    },
  },
  call: {
    usage: CALL_USAGE,
    summary: "Call one of slop's MCP tools and print its JSON result",
    run: async (args, context) => {
      expectArgs(args, 1, 2, CALL_USAGE);
      const [tool, json] = args;
      if (tool === undefined) throw new UsageError(`usage: slop ${CALL_USAGE}`);
      const value = await clientFor(context).call(tool, parseToolArguments(json));
      context.stdout(`${JSON.stringify(value)}\n`);
    },
  },
  api: {
    usage: API_USAGE,
    summary: "Call slop's REST API (the board's API, e.g. board settings) and print its JSON",
    run: async (args, context) => {
      expectArgs(args, 2, 3, API_USAGE);
      const [method, path, json] = args;
      const verb = API_METHODS.find((m) => m === method?.toUpperCase());
      if (verb === undefined || path === undefined)
        throw new UsageError(`usage: slop ${API_USAGE}`);
      const body = json === undefined ? undefined : parseJsonOrUndefined(json);
      if (json !== undefined && body === undefined) throw new UsageError('the body must be JSON');
      const value = await clientFor(context).rest(verb, path, body);
      context.stdout(`${JSON.stringify(value)}\n`);
    },
  },
  init: {
    usage: INIT_USAGE,
    summary: "Install the board's agent set into this git checkout",
    run: async (args, context) => {
      expectArgs(args, 0, 1, INIT_USAGE);
      const board = resolveBoard(args[0], context.settings);
      const root = context.gitRoot();
      if (root === undefined) throw new SlopError('init: run this inside a git checkout');
      await runInit({
        root,
        board,
        server: resolveMcpServer(context.settings),
        connect: () => ({
          client: clientFor(context),
          slopUrl: requireSetting(context.settings, 'SLOP_URL'),
        }),
        fetch: context.fetch,
        isMcpServerConfigured: context.isMcpServerConfigured,
        now: context.now,
        log: context.log,
        stdout: context.stdout,
      });
    },
  },
  glob: {
    usage: GLOB_USAGE,
    summary: "Print a glob's summary (status, branch, implementer, run, PR)",
    run: (args, context) => globCommand(args, globDeps(context)),
  },
  'pick-up': {
    usage: PICK_UP_USAGE,
    summary: 'Become the implementer of a glob and wait for its branch; prints the branch',
    run: (args, context) => pickUpCommand(args, globDeps(context)),
  },
  new: {
    usage: NEW_USAGE,
    summary: 'Create a glob on SLOP_BOARD from a prompt (intake fills in the rest)',
    run: (args, context) => newCommand(args, globDeps(context)),
  },
  ready: {
    usage: READY_USAGE,
    summary: "Push the glob's branch (default: the current one) and mark its PR ready",
    run: (args, context) => readyCommand(args, globDeps(context)),
  },
  'put-artifact': {
    usage: PUT_ARTIFACT_USAGE,
    summary: 'Upload the implementation record (postplan is an alias) or a local review from a file (or - for stdin) to a glob',
    run: (args, context) =>
      putArtifactCommand(args, {
        client: clientFor(context),
        readInput: context.readInput ?? readInputDefault,
        stdout: context.stdout,
      }),
  },
  merge: {
    usage: MERGE_USAGE,
    summary: "Merge the glob (default: the current branch's) through slop, like its Merge button",
    run: (args, context) => mergeCommand(args, globDeps(context)),
  },
};

const HELP_USAGE_WIDTH = 40;

export function helpText(): string {
  // A usage longer than the column gets its summary on the next line.
  const width = Math.min(
    HELP_USAGE_WIDTH,
    Math.max(...Object.values(COMMANDS).map((command) => command.usage.length)),
  );
  const lines = Object.values(COMMANDS).map((command) =>
    command.usage.length > width
      ? `  slop ${command.usage}\n  ${' '.repeat(width + 5)}  ${command.summary}`
      : `  slop ${command.usage.padEnd(width)}  ${command.summary}`,
  );
  return [
    'slop: the command line for slop',
    '',
    'Usage:',
    ...lines,
    `  slop ${'--help'.padEnd(width)}  Show this help`,
    '',
    'Settings (environment first, then these files):',
    `  ${userConfigPath()}, then .sstor/sstor.conf in the git root (KEY=VALUE lines)`,
    '  SLOP_URL        slop server, e.g. https://slop.example.com',
    '  SLOP_CLIENT_ID  the Cognito app client for the CLI',
    '  SLOP_DEV_EMAIL  sign in as this person against a server with AUTH_MODE=dev',
    '  SLOP_BOARD      the board for slop init (when none is given) and slop new',
    "  SLOP_MCP_SERVER slop's MCP server name in Claude Code (default slop)",
    '',
    'Exit codes: 0 ok, 1 slop or sign-in error, 2 usage error.',
    '',
  ].join('\n');
}

/** Runs the command line and returns the exit code; never throws. */
export async function main(argv: readonly string[], context: CliContext): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    (name === undefined ? context.log : context.stdout)(helpText());
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    context.log(`slop: unknown command '${name}'\n\n${helpText()}`);
    return EXIT_USAGE;
  }
  const warning = insecureUrlWarning(context.settings);
  if (warning !== undefined) context.log(warning);
  try {
    await command.run(args, context);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      context.log(`slop: ${error.message}`);
      return EXIT_USAGE;
    }
    context.log(`slop: ${describeError(error)}`);
    return EXIT_FAILURE;
  }
}
