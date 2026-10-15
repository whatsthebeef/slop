import { isArchivedDecision } from '../../domain/decision-glob.js';
import { GROUP_CONTEXT_MAX_GLOBS, contextNeighbours, groupContext, inGroup } from '../../domain/group-view.js';
import type { GroupContext } from '../../domain/group-view.js';
import { handoverBrief, openFindings, resumePhase } from '../../domain/handover.js';
import type { Handover } from '../../domain/handover.js';
import type { Glob } from '../../domain/types.js';
import type { Clock, Tx } from '../../ports.js';

/** The hand-over brief of a glob as it stands, from its newest local review and uploaded artifacts. */
export const handoverOf = async (tx: Tx, clock: Clock, glob: Glob): Promise<Handover | null> => {
  const findings = openFindings(await tx.listFindings(glob.id), await tx.listReviewSources(glob.id));
  const artifacts = await tx.listArtifactSummaries(glob.boardId, [glob.id]);
  return handoverBrief(glob, { now: clock.now(), findings, resumePhase: resumePhase(artifacts, glob.pr?.headSha ?? null) });
};

/** The group section of a glob's context: its neighbours and open decisions; null when it has none. */
export const groupSection = async (tx: Tx, clock: Clock, glob: Glob): Promise<GroupContext | null> => {
  if (glob.group === null) return null;
  const all = await tx.listGlobs(glob.boardId, { include: 'all' });
  const members = all.filter((g) => inGroup(g, glob.group ?? '') && !isArchivedDecision(g));
  const relations = await tx.listRelationsFrom(members.filter((g) => g.category !== 'decision').map((g) => g.id));
  const memberIds = new Set(members.map((g) => g.id));
  const others = await tx.getGlobs([...new Set(relations.map((r) => r.to))].filter((id) => !memberIds.has(id)));
  // Plans only for the neighbours the context shows, in one read.
  const shown = contextNeighbours(glob, members, clock.now()).slice(0, GROUP_CONTEXT_MAX_GLOBS);
  const plans = new Map((await tx.latestArtifacts(shown.map((g) => g.id), ['plan'])).map((a) => [a.globId, a.content]));
  return groupContext(glob, members, relations, plans, others.filter((g) => g.category === 'decision' && !isArchivedDecision(g)), clock.now());
};
