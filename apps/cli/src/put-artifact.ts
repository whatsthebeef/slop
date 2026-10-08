import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';
import type { ToolCaller } from './init.js';
import { parseJsonOrUndefined } from './util.js';

export const PUT_ARTIFACT_USAGE =
  'put-artifact <id> --kind implementation_plan|postplan|local_review --file <path|-> [--commit <sha>] [--agent-set <n>] [--review-stats <json>] [--run <runId>]';

const KINDS = ['implementation_plan', 'postplan', 'local_review'] as const;

export interface PutArtifactDeps {
  readonly client: ToolCaller;
  /** Reads a file's text; `-` is stdin, which the caller resolves. */
  readonly readInput: (path: string) => Promise<string>;
  readonly stdout: (text: string) => void;
}

const reviewStatsSchema = z.object({
  riskTier: z.enum(['low', 'normal', 'high']),
  reviewRounds: z.number().int().min(0).max(20),
  maxReviewRounds: z.number().int().min(0).max(20),
  testFailRounds: z.number().int().min(0).max(20),
});

const VALUE_FLAGS = [
  '--kind',
  '--file',
  '--commit',
  '--agent-set',
  '--review-stats',
  '--run',
] as const;

/** `slop put-artifact`: reads the file and calls put_artifact, so its text never goes through a tool call. */
export async function putArtifactCommand(
  args: readonly string[],
  deps: PutArtifactDeps,
): Promise<void> {
  const usage = `usage: slop ${PUT_ARTIFACT_USAGE}`;
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value\n${usage}`);
      values.set(arg, value);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}\n${usage}`);
    } else {
      positionals.push(arg);
    }
  }
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1) throw new UsageError(usage);
  const kind = KINDS.find((k) => k === values.get('--kind'));
  if (kind === undefined) throw new UsageError(`--kind must be one of ${KINDS.join(', ')}`);
  const file = values.get('--file');
  if (file === undefined) throw new UsageError(`--file is required\n${usage}`);

  const toolArgs: Record<string, unknown> = { id, kind };
  const commit = values.get('--commit');
  if (commit !== undefined) toolArgs.commitSha = commit;
  const run = values.get('--run');
  if (run !== undefined) toolArgs.runId = run;
  const agentSet = values.get('--agent-set');
  if (agentSet !== undefined) {
    if (!/^\d+$/.test(agentSet)) throw new UsageError('--agent-set must be a non-negative integer');
    toolArgs.agentSetVersion = Number(agentSet);
  }
  const stats = values.get('--review-stats');
  if (stats !== undefined) {
    const parsed = reviewStatsSchema.safeParse(parseJsonOrUndefined(stats));
    if (!parsed.success) {
      throw new UsageError(
        '--review-stats must be JSON like {"riskTier":"normal","reviewRounds":1,"maxReviewRounds":2,"testFailRounds":0}',
      );
    }
    toolArgs.reviewStats = parsed.data;
  }

  let content: string;
  try {
    content = await deps.readInput(file);
  } catch (error) {
    throw new SlopError(
      `put-artifact: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (content.trim() === '') throw new SlopError(`put-artifact: ${file} is empty`);
  deps.stdout(
    `${JSON.stringify(await deps.client.call('put_artifact', { ...toolArgs, content }))}\n`,
  );
}
