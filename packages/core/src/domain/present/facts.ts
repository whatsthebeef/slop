import type { Action } from '../machine.js';
import type { ActionPreparation } from '../attributes.js';
import type { ActionState } from '../action-glob.js';
import type { ArtifactSummary } from '../knowledge.js';
import type { Arm } from '../rollout-stages.js';
import type { ClickOutcome, Glob, List, Mode, PendingAction, Run, WorkActor } from '../types.js';
import type { CompactHumanStep, HumanStep } from '../human-steps.js';
import type { Handoff } from '../../app/glob-service.js';
import type { Handover } from '../handover.js';
import type { HeldBack, Holding, RelationsView } from '../relations.js';
import type { MachineStep } from '../machine-steps.js';
import type { Move } from '../whose-move.js';
import type { OpenQuestion } from '../questions.js';
import type { RelationSuggestion } from '../relation-scan.js';
import type { SizeCheck } from '../size-check.js';
import type { WorkstreamsSummary } from '../workstreams.js';

export type ArtifactSummaryView = Omit<ArtifactSummary, 'globId'>;

/** A step on the board list is compact; a single-glob read adds the rest (read each with `?.`). */
export type ListedHumanStep = CompactHumanStep &
  Partial<
    Pick<
      HumanStep,
      | 'detail'
      | 'script'
      | 'check'
      | 'why'
      | 'permissions'
      | 'commands'
      | 'verify'
      | 'source'
      | 'doneBy'
      | 'doneAt'
      | 'dismissedReason'
    >
  >;

export interface PresentableGlob extends Glob {
  /** Who works on the glob and how (derived on the server; read through `actorOf` and `modeOf` where a fixture may lack them). */
  readonly actor?: WorkActor;
  readonly mode?: Mode;
  readonly list: List;
  readonly branch: string;
  readonly currentRun: Run | null;
  readonly allowedActions?: readonly Action[];
  /** A click whose effect is still to show (read it through `pendingInForce`), and how the last click failed; both absent on an older API. */
  readonly pendingAction?: PendingAction | null;
  readonly lastOutcome?: ClickOutcome | null;
  /** An action glob's derived state (open, waiting, preparing, preparation_failed, ready, recording, closed); absent on other globs and on an older API. */
  readonly actionState?: ActionState;
  /** An action glob's machine preparation (record kind, rounds), or null for a plain action; absent on an older API. */
  readonly preparation?: ActionPreparation | null;
  /** The latest version of each artifact (board list and glob reads; absent from some write responses). */
  readonly artifacts?: readonly ArtifactSummaryView[];
  /** Every relation of the glob that still holds something back (any gate), with the title of what it points at; computed on the server for the board list and the glob read (read with `?.`: absent on an older API). */
  readonly holding?: readonly Holding[];
  /** The glob's relations in groups: holding it back, held back by it, and no longer holding (single-glob reads only). */
  readonly relations?: RelationsView;
  /** Other globs' relations that wait for this one (board list rows; redacted for boards the viewer is not on); absent when none or on an older API. */
  readonly holdsBack?: readonly HeldBack[];
  /** Open card suggestions from the automatic relation pass; absent when none or on an older API. */
  readonly suggestions?: readonly RelationSuggestion[];
  /** Open and answered questions (the "the AI is unsure" marker); absent on an older API or when the glob has none (read with `?.`). */
  readonly questions?: readonly OpenQuestion[];
  /** Set when the glob came from a split: the glob that was cut, this one's place (0 is the original) and every part's ID. */
  readonly split?: {
    readonly source: string;
    readonly part: number;
    readonly parts: readonly string[];
  };
  /** A fanned-out glob's workstreams in compact form, for the card's workstream states; absent for a small glob or an older API. */
  readonly workstreams?: WorkstreamsSummary;
  /** True while the size check flagged the glob oversized and it hasn't started (advice only; the card's chip). */
  readonly oversized?: boolean;
  /** The size check: why it was flagged, its evidence and the forecast's workstreams, advice only (single-glob reads only). */
  readonly sizeCheck?: SizeCheck;
  /** Why a person is needed and what to do first; null when nothing is wrong, absent on an older API (single-glob reads only). */
  readonly handover?: Handover | null;
  /** An open action's script (a `script:` line in its plan) and whether the base branch has it (null: could not check); null when it names none; absent on an older API and for other globs on the list. */
  readonly script?: { readonly path: string; readonly onBase: boolean | null } | null;
  /** The status messages the viewer dismissed on this glob (see `lib/dismissals.ts`); absent on an older API. */
  readonly dismissedKeys?: readonly string[];
  /** The check a sub on the board waits for (the merge policy's `subGateCheck`); absent on an older API, read as `checks`. */
  readonly gateCheck?: string;
  /** What a person must do on the glob, most pressing first: compact on the board list, in full on a single read; absent on an older API. */
  readonly humanSteps?: readonly ListedHumanStep[];
  /** Open rollout steps holding back sign-off, counted by the server (a same with any is merged with Merge and continue); absent on an older API, read with `?.`. */
  readonly rolloutSteps?: number;
  /** The "Arm system" label: the title of the first open rollout step (a downstream step counts, signed off or not); absent when none is open or on an older API. */
  readonly arm?: Arm;
  /** Whose move it is, derived on every read (board list only; absent on an older API). */
  readonly move?: Move;
  /** What slop is doing for the glob (board list and glob read; absent on an older API). */
  readonly machineSteps?: readonly MachineStep[];
  /** Who picked the glob up, took it over or handed it to the machine, oldest first (single-glob reads only; absent on an older API). */
  readonly handoffs?: readonly Handoff[];
}
