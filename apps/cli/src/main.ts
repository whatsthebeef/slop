import { z } from 'zod';
import { accessToken, login, logout, type AuthDeps } from './auth.js';
import { SlopClient, type ToolArguments } from './client.js';
import { insecureUrlWarning, requireSetting, userConfigPath } from './config.js';
import { SlopError, UsageError } from './errors.js';
import { resolveBoard, resolveMcpServer, runInit } from './init.js';
import { describeError, parseJsonOrUndefined } from './util.js';

/** Everything a command needs from the outside world; bin.ts wires the real ones. */
export interface CliContext extends AuthDeps {
  readonly stdout: (text: string) => void;
  /** The enclosing git checkout's root, or undefined outside one. */
  readonly gitRoot: () => string | undefined;
  /** Whether the developer already has this MCP server configured in Claude Code. */
  readonly isMcpServerConfigured: (server: string, root: string) => Promise<boolean>;
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

function expectArgs(args: readonly string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new UsageError(`usage: slop ${usage}`);
}

const CALL_USAGE = "call <tool> ['<json arguments>']";
const INIT_USAGE = 'init [board]';

const whoamiResultSchema = z.object({ email: z.string() });

const toolArgumentsSchema = z.record(z.string(), z.unknown());

function parseToolArguments(text: string | undefined): ToolArguments {
  if (text === undefined) return {};
  const parsed = toolArgumentsSchema.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) throw new UsageError('the tool arguments must be a JSON object');
  return parsed.data;
}

// New commands (init, glob commands) are added here.
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
};

export function helpText(): string {
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length));
  const lines = Object.values(COMMANDS).map(
    (command) => `  slop ${command.usage.padEnd(width)}  ${command.summary}`,
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
    '  SLOP_BOARD      the board slop init installs when none is given',
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
