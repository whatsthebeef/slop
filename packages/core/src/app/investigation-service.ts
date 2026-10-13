import type { Result } from '../domain/errors.js';
import { escalationOf, oversizeOf, parseInvestigation } from '../domain/investigation.js';
import { evidenceOf } from '../domain/size-check.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { checkFrom } from './size-check-service.js';
import { hash } from './text-hash.js';

/** What slop does when an investigation arrives (spec, Investigation as data): flag the glob for a human, or for its size. */
export interface InvestigationReactor {
  /** Never throws: a failed reaction must not lose the artifact. Resolves once slop has acted. */
  react(email: string, globId: string, runId: string | null, content: string): Promise<void>;
}

/**
 * On receipt of an `investigation` artifact slop compares it with the glob. `needsHuman`, or a risk-area hit, on a sub
 * escalates it to a same with the reason. Parts at the board's limit raise the oversize flag with a fan-out proposal built
 * from them, unless a person has already answered the flag. Nothing here stops the run: the run goes on unless the glob
 * was escalated and the board's policy says to wait (no such policy exists yet).
 */
export class InvestigationService implements InvestigationReactor {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** `GlobService.escalateToSame`; the machine ignores a stale run and a same. */
      escalate: (email: string, globId: string, input: { reason: string; evidence: string; runId: string | null }) => Promise<Result<unknown>>;
    },
  ) {}

  async react(email: string, globId: string, runId: string | null, content: string): Promise<void> {
    try {
      const parsed = parseInvestigation(content);
      if (!parsed.ok) return;
      const { investigation } = parsed;
      const read = await this.deps.store.transaction(async (tx) => {
        const glob = await tx.getGlob(globId);
        if (glob === null) return null;
        const plan = (await tx.artifactVersions(globId, 'plan', '')).at(-1)?.content ?? '';
        return { glob, plan, threshold: await tx.getSizeThreshold(glob.boardId), check: await tx.getSizeCheck(globId) };
      });
      if (read === null) return;
      const { glob } = read;

      const escalation = glob.type === 'sub' ? escalationOf(investigation) : null;
      if (escalation !== null) await this.deps.escalate(email, globId, { ...escalation, runId });

      // A person's answer to the flag stands; a merged or finished glob has nothing left to cut.
      if (read.check?.decision != null || !['planning', 'implementing'].includes(glob.status)) return;
      const oversize = oversizeOf(investigation, read.threshold, read.plan, glob.title);
      if (oversize === null) return;
      const raised = await this.deps.store.transaction(async (tx) => {
        const current = await tx.getGlob(globId);
        const previous = await tx.getSizeCheck(globId);
        if (current === null || previous?.decision != null) return false;
        const estimate = {
          ...(previous?.estimate ?? { tasks: 0, doneWhenLines: 0, areas: [], untaskedSections: 0 }),
          independentParts: investigation.parts.length,
          partsSource: 'model' as const,
          reasoning: 'The investigator named these parts from the code',
        };
        await tx.upsertSizeCheck(
          checkFrom(
            globId,
            glob.boardId,
            { planHash: previous?.planHash ?? hash(read.plan), estimate, evidence: evidenceOf(estimate), threshold: read.threshold, flagged: true, reasons: oversize.reasons, proposal: oversize.proposal },
            previous,
            this.deps.clock.now(),
          ),
        );
        return true;
      });
      if (raised) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: glob.boardId, globId });
    } catch {
      // Best effort: the investigation is stored, and a person sees it on the card.
    }
  }
}
