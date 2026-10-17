import { LlmUnavailable, matchesGlob } from '@slop/core';
import type { Board, EffectKind, PostMergeKnowledgeService, SpecReader } from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import type { Executor } from './jobs/outbox.js';

/** An unusable model (credentials, busy) is waited out without spending an attempt; the next try is this much later. */
const MODEL_WAIT_MS = 5 * 60_000;
/** Most spec and guide files one pass reads, and how long one code-host call may take. */
const MAX_SPEC_FILES = 6;
const CALL_TIMEOUT_MS = 30_000;

/**
 * The post-merge knowledge pass (`post_merge_knowledge`, on the `llm` lane): fact learnings and a spec/guide drift sub for a glob that
 * merged for good, whoever built it. The generation check is the outbox's; `run` drops a glob that has not merged. A model that gave no
 * usable answer throws and the runner retries (3 attempts); an unavailable model waits without spending one.
 */
export const postMergeKnowledgeExecutors = (
  pass: Pick<PostMergeKnowledgeService, 'run'>,
): Partial<Record<EffectKind, Executor>> => ({
  post_merge_knowledge: async (effect, glob) => {
    if (effect.kind !== 'post_merge_knowledge' || glob === null) return 'dropped';
    try {
      return await pass.run(effect.globId, effect.sha);
    } catch (error) {
      if (error instanceof LlmUnavailable)
        return { state: 'pending', retryAfterMs: MODEL_WAIT_MS, reason: error.message };
      throw error;
    }
  },
});

/** The directory a path glob starts in: its leading segments without a wildcard. */
const dirOf = (glob: string): string => {
  const segments = glob.split('/').slice(0, -1);
  const plain = segments.findIndex((s) => /[*?]/.test(s));
  return (plain === -1 ? segments : segments.slice(0, plain)).join('/');
};

/**
 * The board's spec and guide files at a commit. A path without wildcards is read directly; a glob lists the files directly in the
 * directory it starts in (the host lists one level) and keeps those it matches. At most `MAX_SPEC_FILES` files; an unreadable one is left out.
 */
export class HostSpecReader implements SpecReader {
  constructor(private readonly host: Pick<CodeHost, 'readFile' | 'listFiles'>) {}

  async read(
    board: Board,
    sha: string,
    paths: readonly string[],
  ): Promise<readonly { readonly path: string; readonly text: string }[]> {
    const repo = repoOf(board);
    if (repo === null) return [];
    const found: string[] = [];
    for (const glob of paths) {
      if (!/[*?]/.test(glob)) {
        if (!found.includes(glob)) found.push(glob);
        continue;
      }
      const dir = dirOf(glob);
      for (const name of await this.host.listFiles(
        repo,
        sha,
        dir === '' ? '.' : dir,
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      )) {
        const path = dir === '' ? name : `${dir}/${name}`;
        if (matchesGlob(path, glob) && !found.includes(path)) found.push(path);
      }
    }
    const out: { path: string; text: string }[] = [];
    for (const path of found.slice(0, MAX_SPEC_FILES)) {
      const text = await this.host.readFile(repo, sha, path, AbortSignal.timeout(CALL_TIMEOUT_MS));
      if (text !== null) out.push({ path, text });
    }
    return out;
  }
}
