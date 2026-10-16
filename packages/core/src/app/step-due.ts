import type { HumanStepDue, StoredHumanStep } from '../domain/human-steps.js';
import type { Glob } from '../domain/types.js';
import type { Tx } from '../ports.js';

/**
 * When an `after_deploy:<env>` step falls due (`StoredHumanStep.dueSince`). It is written, not derived, so a rollback never
 * takes a step back out of due: slop sets it when the glob's branch is deployed to the (dev) environment, or when a person
 * marks the environment deployed. A succeeded branch deploy counts, before the merge too (`DeployService.finish` marks the steps).
 */

/** The steps of these globs that wait for a deploy to `environment` and aren't due yet, now due: saved, and returned. */
export const markStepsDue = async (tx: Tx, boardId: number, globIds: readonly string[], environment: string, now: string): Promise<StoredHumanStep[]> => {
  if (globIds.length === 0) return [];
  const due: HumanStepDue = `after_deploy:${environment}`;
  const marked = (await tx.listHumanSteps(boardId, globIds))
    .filter((s) => s.state === 'open' && s.due === due && s.dueSince === null)
    .map((s): StoredHumanStep => ({ ...s, dueSince: now }));
  if (marked.length > 0) await tx.saveHumanSteps(marked);
  return marked;
};

/**
 * `dueSince` for a step being written for `due`: null unless the step waits for a deploy and the glob is already there. That
 * is when a branch deploy of the glob to the environment has succeeded, a person marked it deployed earlier, or another step of the glob for the same
 * environment is already due (so a re-read record's new step doesn't wait for a deploy that already happened).
 */
export const dueSinceFor = async (tx: Tx, glob: Pick<Glob, 'id' | 'boardId'>, due: HumanStepDue, siblings: readonly StoredHumanStep[], now: string): Promise<string | null> => {
  if (!due.startsWith('after_deploy:')) return null;
  const environment = due.slice('after_deploy:'.length);
  const inherited = siblings.find((s) => s.due === due && s.dueSince !== null)?.dueSince;
  if (inherited !== undefined && inherited !== null) return inherited;
  if ((await tx.listDeploys(glob.boardId, { environment, globIds: [glob.id], states: ['succeeded'], limit: 1 })).length > 0) return now;
  const marks = await tx.listBoardEvents(glob.boardId, '1970-01-01T00:00:00.000Z', ['EnvironmentMarkedDeployed'], [glob.id]);
  return marks.some((e) => e.data.environment === environment) ? now : null;
};
