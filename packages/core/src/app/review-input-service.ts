import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isReviewGuide } from '../domain/code-review.js';
import { isSuperseded } from '../domain/decisions.js';
import type { Decision } from '../domain/decisions.js';
import type { ReviewInput } from '../domain/independent-review.js';
import { filterDiff, planSummary, renderHistoryBriefing } from '../domain/review-input.js';
import type { FileChange, FileDecision, FileHistory, SkippedFile } from '../domain/review-input.js';
import { testRunFailed } from '../domain/test-runs.js';
import type { Store, Tx } from '../ports.js';

/** The history lookup is a few queries per file: past this many files the rest get no briefing. */
export const MAX_HISTORY_FILES = 30;
/** Candidates fetched per file before the path check and the per-file cap trim them. */
const CHANGES_POOL = 20;

export interface ReviewTarget {
  readonly boardId: number;
  readonly globId: string;
  /** The change as a git unified diff: the PR's test-merge diff, or the glob's squash commit. */
  readonly diff: string;
}

export interface AssembledReview {
  readonly input: ReviewInput;
  /** The files whose diff the reviewer reads. */
  readonly files: readonly string[];
  readonly skipped: readonly SkippedFile[];
}

/** A finding's stored path against a diff path (a source may name the file with or without a leading directory). */
const samePath = (stored: string | null, path: string): boolean =>
  stored !== null &&
  (stored === path || stored.endsWith(`/${path}`) || path.endsWith(`/${stored}`));

/**
 * Assembles what the reviewer reads for one change: only the changed code (lockfiles, generated and ignored files
 * left out), the glob's plan summary and "Done when" lines, the board's review guide, and the Level 1 history
 * briefing for each touched file, from data slopmux already stores. It only reads: no code host, no model.
 */
export class ReviewInputService {
  constructor(private readonly deps: { store: Store }) {}

  /** `ignoredPaths`: the board's own ignored paths, as patterns. */
  async assemble(
    target: ReviewTarget,
    ignoredPaths: readonly RegExp[] = [],
  ): Promise<Result<AssembledReview>> {
    const filtered = filterDiff(target.diff, ignoredPaths);
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(target.globId);
      if (glob === null || glob.boardId !== target.boardId)
        return notFound(`Glob ${target.globId} is not on board ${target.boardId}`);

      const plan = (await tx.listArtifacts(glob.id, 'plan')).reduce<{
        version: number;
        content: string;
      } | null>(
        (latest, artifact) =>
          latest === null || artifact.version > latest.version ? artifact : latest,
        null,
      );
      const guides = (await tx.listKnowledge(target.boardId, ['doc'])).filter(isReviewGuide);
      const history = await this.history(tx, target.boardId, glob.id, filtered.files);

      const input: ReviewInput = {
        diff: filtered.diff,
        plan: planSummary(glob, plan?.content ?? null),
        reviewGuide: guides
          .map((doc) =>
            guides.length === 1 ? doc.content.trim() : `### ${doc.name}\n\n${doc.content.trim()}`,
          )
          .join('\n\n'),
        context: renderHistoryBriefing(history),
      };
      return ok({ input, files: filtered.files, skipped: filtered.skipped });
    });
  }

  /** Earlier changes, problems and decisions for each file, leaving out the glob under review itself. */
  private async history(
    tx: Tx,
    boardId: number,
    ownGlob: string,
    files: readonly string[],
  ): Promise<FileHistory[]> {
    const decisions = await tx.listDecisions(boardId);
    const problemsByGlob = new Map<string, readonly { path: string | null; text: string }[]>();
    const testsByGlob = new Map<string, string[]>();

    const loadGlob = async (globId: string): Promise<void> => {
      if (problemsByGlob.has(globId)) return;
      problemsByGlob.set(
        globId,
        (await tx.listFindings(globId))
          .filter((f) => f.severity !== 'suggestion')
          .map((f) => ({ path: f.path, text: `${globId} review: ${f.text}` })),
      );
      const failed = (await tx.listTestRuns(boardId, { globIds: [globId] })).filter(testRunFailed);
      testsByGlob.set(
        globId,
        failed.map(
          (run) =>
            `a test run of ${globId} at ${run.sha.slice(0, 7)} failed ${run.failed} test${run.failed === 1 ? '' : 's'}`,
        ),
      );
    };

    const out: FileHistory[] = [];
    for (const path of files.slice(0, MAX_HISTORY_FILES)) {
      const candidates = await tx.changeCandidates(
        { boardId, query: path, mode: 'current' },
        CHANGES_POOL,
      );
      const seen = new Set<number>();
      const changes: FileChange[] = [];
      for (const c of candidates) {
        // The store matches words as well as the Files line: only a change that names this file is about it.
        if (seen.has(c.itemId) || c.globIds.includes(ownGlob) || !c.text.includes(path)) continue;
        seen.add(c.itemId);
        changes.push({
          globId: c.globIds[0] ?? null,
          title: c.title,
          date: c.occurredAt,
          summary: c.text,
        });
      }
      changes.sort((a, b) => b.date.localeCompare(a.date));

      const globs = [...new Set(changes.flatMap((c) => (c.globId === null ? [] : [c.globId])))];
      for (const globId of globs) await loadGlob(globId);
      const problems = globs.flatMap((globId) => [
        ...(problemsByGlob.get(globId) ?? [])
          .filter((p) => samePath(p.path, path))
          .map((p) => p.text),
        ...(testsByGlob.get(globId) ?? []).map((t) => `${t} (it changed this file)`),
      ]);
      out.push({ path, changes, problems, decisions: fileDecisions(decisions, globs) });
    }
    return out;
  }
}

/** The decisions taken on the globs that changed the file, current ones first, superseded ones marked as history. */
const fileDecisions = (decisions: readonly Decision[], globs: readonly string[]): FileDecision[] =>
  decisions
    .filter((d) => d.globId !== null && globs.includes(d.globId))
    .map((d) => ({
      globId: d.globId,
      statement: d.statement,
      date: d.decidedAt,
      superseded: isSuperseded(d),
    }))
    .sort((a, b) => Number(a.superseded) - Number(b.superseded) || b.date.localeCompare(a.date));
