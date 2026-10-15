import { isHumanCategory } from '../domain/types.js';
import { ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { decisionOf } from '../domain/decision-glob.js';
import { decisionGroup, proposeSplitGroups } from '../domain/group.js';
import type { Glob, Relation } from '../domain/types.js';
import type { Store } from '../ports.js';
import { adminOf } from './access.js';
import type { GlobService } from './glob-service.js';
import type { IntakeService } from './intake-service.js';

/** One group the backfill proposes for a glob that has none. */
export interface GroupBackfillItem {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  /** `split`: it is a part of a split with the others; `suggested`: intake's group rule chose it from its title and plan. */
  readonly why: 'split' | 'suggested';
  /** Set once applied: `applied` or the reason the write was refused. */
  readonly result?: string;
}

export interface GroupBackfillResult {
  readonly applied: boolean;
  readonly items: readonly GroupBackfillItem[];
}

/** Relations (either way) and predicted overlaps alike: the split check on the titles keeps an unrelated edge from joining two splits. */
const linksOf = (glob: Glob, relations: readonly Relation[]): string[] => [
  ...relations.filter((r) => r.from === glob.id).map((r) => r.to),
  ...relations.filter((r) => r.to === glob.id).map((r) => r.from),
  ...(glob.impliedAfter ?? []).map((i) => i.id),
];

/**
 * Proposes groups for a board's open globs that have none (the globs made before new ones always got a group), and with `apply`
 * writes them through `GlobService.update` at the version it read. Split parts come first, from their titles and edges; the rest
 * get intake's group-only suggestion. A person checks the dry run first: nothing here rewrites data on its own.
 */
export class GroupBackfillService {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly globs: Pick<GlobService, 'update'>;
      readonly intake: Pick<IntakeService, 'suggestGroup'>;
    },
  ) {}

  /**
   * One-off, at start-up: open decision globs with no group get the one a new decision would (`decisionGroup`): the target's name
   * for a learning, `hotspots`, else the group of the work glob its scope names. Idempotent: only group-less ones are written,
   * and a person's own group stays. Returns how many it wrote.
   */
  async backfillDecisionGroups(boardId: number): Promise<number> {
    return this.deps.store.transaction(async (tx) => {
      const globs = await tx.listGlobs(boardId, { include: 'all' });
      const byId = new Map(globs.map((g) => [g.id, g]));
      let written = 0;
      for (const glob of globs) {
        const attributes = decisionOf(glob);
        if (attributes === null || glob.group !== null || glob.status === 'signed_off') continue;
        const scoped = attributes.scope.kind === 'glob' ? byId.get(attributes.scope.ref) : undefined;
        const group = decisionGroup(attributes, scoped?.category === 'decision' ? null : (scoped?.group ?? null));
        if (group === null) continue;
        if (await tx.updateGlob({ ...glob, group, version: glob.version + 1 }, glob.version)) written += 1;
      }
      return written;
    });
  }

  async run(email: string, boardId: number, apply: boolean): Promise<Result<GroupBackfillResult>> {
    const read = await this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      return actor.ok ? ok({ globs: await tx.listGlobs(boardId, {}), relations: await tx.listRelations(boardId) }) : actor;
    });
    if (!read.ok) return read;
    // Decisions and signed-off globs are history: their group is not worth rewriting.
    const open = read.value.globs.filter((g) => !isHumanCategory(g.category) && g.status !== 'signed_off');
    const existing = [...new Set(read.value.globs.flatMap((g) => (g.group === null ? [] : [g.group])))];
    const byId = new Map(open.map((g) => [g.id, g]));
    const items: GroupBackfillItem[] = [];
    const proposed = new Set<string>();
    const add = (item: Omit<GroupBackfillItem, 'title'>): void => {
      items.push({ ...item, title: byId.get(item.id)?.title ?? '' });
      proposed.add(item.id);
    };

    const splits = proposeSplitGroups(open.map((g) => ({ id: g.id, title: g.title, group: g.group, linked: linksOf(g, read.value.relations) })), existing);
    for (const p of splits) add({ id: p.id, group: p.group, why: 'split' });
    for (const glob of open) {
      if (glob.group !== null || proposed.has(glob.id)) continue;
      const plan = (await this.deps.store.transaction((tx) => tx.listArtifacts(glob.id, 'plan')))[0]?.content ?? '';
      const suggested = await this.deps.intake.suggestGroup(email, boardId, { title: glob.title, plan });
      if (suggested.ok && suggested.value !== null) add({ id: glob.id, group: suggested.value, why: 'suggested' });
    }
    if (!apply) return ok({ applied: false, items });

    const written: GroupBackfillItem[] = [];
    for (const item of items) {
      const glob = byId.get(item.id);
      if (glob === undefined) continue;
      const result = await this.deps.globs.update(email, item.id, glob.version, { group: item.group });
      written.push({ ...item, result: result.ok ? 'applied' : result.error.message });
    }
    return ok({ applied: true, items: written });
  }
}
