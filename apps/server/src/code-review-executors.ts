import type { Board, EffectKind } from '@slop/core';
import type { CodeHost } from './codehost.js';
import { repoOf } from './codehost.js';
import { CODERABBIT_CONFIG_FILES, autoReviewDisabled } from './coderabbit-config.js';
import type { Executor } from './jobs/outbox.js';

/** Marks slop's review request, so a retried effect (or a PR marked ready again) asks once per PR. */
export const CODE_REVIEW_REQUEST_MARKER = '<!-- slop:coderabbit-review -->';

export const CODE_REVIEW_REQUEST_BODY = `@coderabbitai review\n\n${CODE_REVIEW_REQUEST_MARKER}`;

/**
 * Outbox executors for CodeRabbit (R3). When a PR becomes ready for review, slop asks CodeRabbit for a review only
 * if the repo's `.coderabbit.yaml` (on the base branch) turns automatic reviews off and the board has a review guide
 * for CodeRabbit to follow; otherwise CodeRabbit reviews on its own, or the board hasn't set it up.
 */
export const codeReviewExecutors = (
  host: Pick<CodeHost, 'configured' | 'readFile' | 'commentOnce'>,
  boardOf: (id: number) => Promise<Board | null>,
  hasReviewGuide: (boardId: number) => Promise<boolean>,
): Partial<Record<EffectKind, Executor>> => ({
  request_code_review: async (_effect, glob) => {
    if (glob?.pr == null || glob.pr.state !== 'ready') return 'dropped';
    const board = await boardOf(glob.boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null || !host.configured) return 'dropped';
    if (!(await hasReviewGuide(glob.boardId))) return 'dropped';
    let config: string | null = null;
    for (const path of CODERABBIT_CONFIG_FILES) {
      config = await host.readFile(repo, repo.base, path);
      if (config !== null) break;
    }
    if (config === null || !autoReviewDisabled(config)) return 'dropped';
    await host.commentOnce(repo, glob.pr.number, CODE_REVIEW_REQUEST_MARKER, CODE_REVIEW_REQUEST_BODY);
    return 'done';
  },
});
