import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';
import type { ToolCaller } from './init.js';

export const GET_ARTIFACT_USAGE =
  'get-artifact <id> [<kind>] [--kind <kind>] [--label <label>] [--out <file>]';

/** The kinds a person fetches: the script a prepared action has them run, or any stored text artifact. */
const KINDS = [
  'rollout_script',
  'implementation_plan',
  'test_plan',
  'local_review',
  'independent_review',
  'investigation',
  'attachment',
] as const;

export interface GetArtifactDeps {
  readonly client: ToolCaller;
  /** Writes the artifact's text to a file. */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly stdout: (text: string) => void;
}

const artifactSchema = z.object({ content: z.string(), label: z.string().optional(), version: z.number().optional() });

const VALUE_FLAGS = ['--kind', '--label', '--out'] as const;

/**
 * `slop get-artifact`: the latest version of one artifact's text, to stdout or `--out`. For a prepared action with an artifact
 * record: `slop get-artifact <id> rollout_script --label "action: <slug>" --out run.sh`, then run the file as the plan says.
 */
export async function getArtifactCommand(args: readonly string[], deps: GetArtifactDeps): Promise<void> {
  const usage = `usage: slop ${GET_ARTIFACT_USAGE}`;
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
  const [id, positionalKind] = positionals;
  if (id === undefined || positionals.length > 2) throw new UsageError(usage);
  const asked = values.get('--kind') ?? positionalKind;
  if (values.has('--kind') && positionalKind !== undefined && positionalKind !== asked) {
    throw new UsageError(`--kind ${asked ?? ''} contradicts ${positionalKind}`);
  }
  const kind = KINDS.find((k) => k === asked);
  if (kind === undefined) throw new UsageError(`a kind is required: one of ${KINDS.join(', ')}\n${usage}`);
  let label = values.get('--label');
  // A script is stored under its label: without one, take the glob's only script.
  if (label === undefined && kind === 'rollout_script') {
    const glob = z.object({ artifacts: z.array(z.object({ kind: z.string(), label: z.string() })).default([]) }).safeParse(await deps.client.call('get_glob', { id }));
    const scripts = glob.success ? glob.data.artifacts.filter((a) => a.kind === 'rollout_script') : [];
    if (scripts.length !== 1) {
      throw new UsageError(
        scripts.length === 0 ? `${id} has no rollout_script yet` : `${id} has several rollout scripts (${scripts.map((a) => a.label).join(', ')}): pass --label`,
      );
    }
    label = scripts[0]?.label;
  }

  const found = artifactSchema.safeParse(await deps.client.call('get_artifact', { id, kind, ...(label === undefined ? {} : { label }) }));
  if (!found.success) throw new SlopError('get_artifact: unexpected response from slop');
  const out = values.get('--out');
  if (out === undefined) {
    deps.stdout(found.data.content.endsWith('\n') ? found.data.content : `${found.data.content}\n`);
    return;
  }
  try {
    await deps.writeFile(out, found.data.content);
  } catch (error) {
    throw new SlopError(`get-artifact: could not write ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }
  deps.stdout(`${id} ${kind}${found.data.version === undefined ? '' : ` v${String(found.data.version)}`} written to ${out}\n`);
}
