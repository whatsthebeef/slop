import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { isArchivedDecision } from '../domain/decision-glob.js';
import { normaliseGroup } from '../domain/group.js';
import { RESERVED_GROUP_NAMES, groupSummaries, groupView, inGroup } from '../domain/group-view.js';
import type { GroupSummary, GroupView } from '../domain/group-view.js';
import { humanSteps } from '../domain/human-steps.js';
import * as machine from '../domain/machine.js';
import { machineSteps, stallThresholds } from '../domain/machine-steps.js';
import { whoseMove } from '../domain/whose-move.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Store } from '../ports.js';
import type { BoardService } from './board-service.js';
import type { GlobService } from './glob-service.js';

/** The longest group name a person can give (a label on a card, not a sentence). */
export const MAX_GROUP_NAME = 60;

export interface RegroupResult {
  /** The name the group has now. */
  readonly name: string;
  /** How many of the group's globs (work and decisions) carry the name now. */
  readonly moved: number;
  /** Globs that couldn't be moved (e.g. a write kept losing its version race); a second call moves them. */
  readonly failed: readonly { readonly id: string; readonly message: string }[];
}

/**
 * Groups are derived: a name on globs, with no row of their own, so a group has no status, branch, run or sign-off. This reads
 * a board's globs into the group list and one group's view, and renames or merges a group by writing the new name on every
 * glob through `GlobService.update` (one `FieldsChanged` event per glob). Relations are never touched by a move.
 */
export class GroupService {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly globs: Pick<GlobService, 'list' | 'listWithArtifacts' | 'humanStepsOf' | 'update' | 'peek'>;
      readonly boards: Pick<BoardService, 'get'>;
      readonly clock: Clock;
    },
  ) {}

  /** The board's groups: name, progress, counts by status and last activity. */
  async list(email: string, boardId: number): Promise<Result<GroupSummary[]>> {
    const read = await this.deps.globs.list(email, boardId, { include: 'all' });
    return read.ok ? ok(groupSummaries(read.value.filter((g) => !isArchivedDecision(g)))) : read;
  }

  /** One group (found by name, ignoring case and separators): its globs, the relations between them and its open decisions. */
  async view(email: string, boardId: number, name: string): Promise<Result<GroupView>> {
    const membership = await this.deps.boards.get(email, boardId);
    if (!membership.ok) return membership;
    const read = await this.deps.globs.listWithArtifacts(email, boardId, { include: 'all' }, (g) => !isArchivedDecision(g) && inGroup(g, name));
    if (!read.ok) return read;
    if (read.value.length === 0) return notFound(`No group ${name} on board ${boardId}`);
    const steps = await this.deps.globs.humanStepsOf(boardId);
    const now = this.deps.clock.now();
    const viewer = { email, role: membership.value.role };
    const thresholds = stallThresholds(membership.value.board);
    const members = read.value.map(({ glob, artifacts, relations, holding }) => {
      const human = humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts) }) }, steps.get(glob.id) ?? []);
      const move = whoseMove(glob, human, machineSteps(glob), holding, now, { viewer, thresholds, complete: false });
      return { glob, move, relations: relations.relations, states: relations.states, holding };
    });
    // Relations to globs outside the group show with their titles (the unmet ones carry theirs already).
    const known = new Set(members.map((m) => m.glob.id));
    const outside = [...new Set(members.flatMap((m) => m.relations.map((r) => r.to)))].filter((id) => !known.has(id));
    const found = await this.deps.store.transaction((tx) => tx.getGlobs(outside));
    const titles = new Map(found.map((g) => [g.id, { title: g.title, decision: g.category === 'decision' }]));
    const stored = members[0]?.glob.group ?? name;
    return ok(groupView(this.spellingOf(members.map((m) => m.glob), name) ?? stored, members, titles));
  }

  /** The most used spelling of the group among its globs. */
  private spellingOf(globs: readonly Glob[], name: string): string | null {
    return groupSummaries(globs).find((s) => normaliseGroup(s.name) === normaliseGroup(name))?.name ?? null;
  }

  /** Renames a group on every glob in it. A name another group already has is a merge: use `merge`. */
  async rename(email: string, boardId: number, name: string, to: string): Promise<Result<RegroupResult>> {
    return this.regroup(email, boardId, name, to, false);
  }

  /** Moves every glob of a group into another existing group, which keeps its own spelling. */
  async merge(email: string, boardId: number, from: string, into: string): Promise<Result<RegroupResult>> {
    return this.regroup(email, boardId, from, into, true);
  }

  /** Group-wide relations set for the group follow its new name, so late joiners keep getting them. */
  private async carryRelations(boardId: number, from: string, name: string): Promise<void> {
    await this.deps.store.transaction(async (tx) => {
      for (const r of await tx.listRelations(boardId)) {
        if (r.group !== null && r.group !== name && normaliseGroup(r.group) === normaliseGroup(from)) await tx.updateRelation(r.id, { group: name });
      }
    });
  }

  private async regroup(email: string, boardId: number, from: string, target: string, merging: boolean): Promise<Result<RegroupResult>> {
    const membership = await this.deps.boards.get(email, boardId);
    if (!membership.ok) return membership;
    const read = await this.deps.globs.list(email, boardId, { include: 'all' });
    if (!read.ok) return read;
    const all = read.value.filter((g) => !isArchivedDecision(g));
    const members = all.filter((g) => inGroup(g, from));
    if (members.length === 0) return notFound(`No group ${from} on board ${boardId}`);
    const wanted = target.trim().replace(/\s+/g, ' ');
    if (!/[\p{L}\p{N}]/u.test(wanted)) return invalidInput('A group needs a name with a letter or a digit');
    if (wanted.length > MAX_GROUP_NAME) return invalidInput(`A group name is limited to ${MAX_GROUP_NAME} characters`);
    if (RESERVED_GROUP_NAMES.includes(normaliseGroup(wanted))) return invalidInput(`${wanted} is reserved: pick another name`);
    const same = normaliseGroup(wanted) === normaliseGroup(from);
    const other = all.filter((g) => inGroup(g, wanted) && !inGroup(g, from));
    if (merging) {
      if (same) return invalidInput('A group can only be merged into another one');
      if (other.length === 0) return notFound(`No group ${wanted} to merge into`);
    } else if (other.length > 0) {
      return invalidInput(`A group called ${wanted} exists: merge into it instead`);
    }
    const name = merging ? (this.spellingOf(other, wanted) ?? wanted) : wanted;
    const failed: { id: string; message: string }[] = [];
    let moved = 0;
    for (const glob of members) {
      if (glob.group === name) {
        moved += 1;
        continue;
      }
      let result = await this.deps.globs.update(email, glob.id, glob.version, { group: name });
      // Someone changed the glob since the list was read: its group is still ours to move, so try once more on the current one.
      if (!result.ok && result.error.code === 'version_conflict') {
        const current = await this.deps.globs.peek(glob.id);
        if (current !== null && inGroup(current, from)) result = await this.deps.globs.update(email, glob.id, current.version, { group: name });
        // Moved elsewhere by someone else: not ours to move, and not counted as carrying the new name.
        else if (current !== null && current.group !== name) continue;
        else if (current !== null) result = ok(current);
      }
      if (result.ok) moved += 1;
      else failed.push({ id: glob.id, message: result.error.message });
    }
    await this.carryRelations(boardId, from, name);
    return ok({ name, moved, failed });
  }
}
