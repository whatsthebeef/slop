import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The part of a glob's current run the teleport decision reads. */
export interface TeleportRun {
  readonly sessionUrl?: string | null | undefined;
  readonly routineOwner?: string | undefined;
}

export interface TeleportInput {
  /** The glob's current run (read before pick-up supersedes it); null when none. */
  readonly run: TeleportRun | null;
  /** `slop whoami`: the signed-in person's email. */
  readonly me: string;
  /** Whether this checkout already has a local Claude conversation. */
  readonly hasLocalConversation: boolean;
  /** `--teleport` / `--no-teleport`. */
  readonly force?: 'teleport' | 'no-teleport' | undefined;
}

export type TeleportDecision =
  | { readonly teleport: true; readonly session: string }
  | { readonly teleport: false; readonly reason: string };

/** The session ID from a run's session URL (its last path segment), or the value itself when it is not a URL. */
export function sessionIdOf(sessionUrl: string): string {
  const value = sessionUrl.trim();
  if (!URL.canParse(value)) return value;
  const segments = new URL(value).pathname.split('/').filter((part) => part !== '');
  return segments[segments.length - 1] ?? value;
}

/**
 * Whether `slop work --agent` carries on the routine's cloud conversation (`claude --teleport`) instead of starting
 * `/run-glob`: the current run is a cloud session whose routine the caller owns and this checkout has no local
 * conversation yet. `--teleport` forces it (a session is still needed); `--no-teleport` never does.
 */
export function decideTeleport(input: TeleportInput): TeleportDecision {
  if (input.force === 'no-teleport') return { teleport: false, reason: '--no-teleport' };
  const url = input.run?.sessionUrl;
  if (url === undefined || url === null || url === '')
    return { teleport: false, reason: 'the current run has no cloud session' };
  const session = sessionIdOf(url);
  if (input.force === 'teleport') return { teleport: true, session };
  const owner = input.run?.routineOwner;
  if (owner === undefined || owner.toLowerCase() !== input.me.toLowerCase()) {
    return { teleport: false, reason: "the run's routine is not yours" };
  }
  if (input.hasLocalConversation)
    return { teleport: false, reason: 'this checkout already has a local Claude conversation' };
  return { teleport: true, session };
}

/** Claude Code keeps a directory's conversations under `~/.claude/projects/<the path with every non-alphanumeric character as "-">`. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether `dir` has a local Claude conversation (a .jsonl file under its projects directory). */
export async function hasLocalConversation(home: string, dir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(home, '.claude', 'projects', encodeProjectDir(dir)));
    return entries.some((entry) => entry.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/** The first message of a teleported session: carry on the routine's work in this checkout. */
export function teleportHandoff(id: string): string {
  return (
    `You are carrying on ${id} from its routine run, now in the developer's checkout on branch ${id}. ` +
    `Read the glob (get_glob, get_context) and .reviews/${id}-*.md, check git status and what the run pushed, then continue ` +
    `from where it stopped (/run-glob --from <phase> ${id}). Ask before anything that cannot be undone.`
  );
}
