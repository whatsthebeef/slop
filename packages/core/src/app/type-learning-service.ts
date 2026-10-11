import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { defaultAreas } from '../domain/risk-area.js';
import {
  TYPE_EXAMPLES_MAX,
  extractTypeSignals,
  typeLearningView,
} from '../domain/type-learning.js';
import type { TypeLearningView, TypeSignals } from '../domain/type-learning.js';
import type { SlopType } from '../domain/types.js';
import type { Clock, Store, Tx } from '../ports.js';
import { adminOf, memberOf } from './access.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

/** What a plan looked like to the board when a person retyped its glob: plan.md v1 against the board's risk areas. */
const signalsFor = async (tx: Tx, boardId: number, globId: string): Promise<TypeSignals> => {
  const stored = await tx.listRiskAreas(boardId);
  const areas = stored.length > 0 ? stored : defaultAreas(boardId, EPOCH);
  const first = (await tx.artifactVersions(globId, 'plan', '')).reduce<string | null>(
    (found, a) => found ?? a.content,
    null,
  );
  return extractTypeSignals(first ?? '', areas);
};

/**
 * Records a person's retype as a type correction (spec, Intake). Learning never fails the change that caused it: a
 * failure is logged and dropped.
 */
export const recordTypeCorrection = async (
  store: Store,
  clock: Clock,
  correction: {
    readonly boardId: number;
    readonly globId: string;
    readonly from: SlopType;
    readonly to: SlopType;
    readonly actor: string;
  },
  log?: (task: string, message: string) => void,
): Promise<void> => {
  if (correction.from === correction.to) return;
  try {
    const at = clock.now();
    await store.transaction(async (tx) =>
      tx.insertTypeCorrection({
        boardId: correction.boardId,
        globId: correction.globId,
        fromType: correction.from,
        toType: correction.to,
        actor: correction.actor,
        at,
        signals: await signalsFor(tx, correction.boardId, correction.globId),
      }),
    );
  } catch (e) {
    log?.('type learning', e instanceof Error ? e.message : String(e));
  }
};

/** The board's latest corrections that haven't been reset, as intake's examples. */
export const recentTypeCorrections = (tx: Tx, boardId: number) =>
  tx.listTypeCorrections(boardId, { limit: TYPE_EXAMPLES_MAX });

/** Board settings' view of what intake learned about types, and the admin's reset. */
export class TypeLearningService {
  constructor(private readonly deps: { store: Store; clock: Clock }) {}

  async view(email: string, boardId: number): Promise<Result<TypeLearningView>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      return ok(typeLearningView(await recentTypeCorrections(tx, boardId)));
    });
  }

  /** Admins: intake goes back to the catalog defaults. The rows stay as history, stamped as reset. */
  async reset(email: string, boardId: number): Promise<Result<TypeLearningView>> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const actor = await adminOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      await tx.resetTypeCorrections(boardId, now);
      return ok(typeLearningView(await recentTypeCorrections(tx, boardId)));
    });
  }
}
