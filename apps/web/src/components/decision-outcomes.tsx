import { decisionOf, KNOWLEDGE_KINDS, RULES_MODEL } from '@slop/core';
import type { DecisionAttributes, DecisionLearning, KbTarget, KnowledgeKind, SuggestionPrefill } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router';
import { KeepAsLearning, inPipeline, PIPELINE_POLL_MS, WatchSignal, watching } from '@/components/decision-learning';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Tip } from '@/components/ui/tip';
import { api } from '@/lib/api';
import type { BoardView, DecideInput, GlobView } from '@/lib/api';
import { adminOnlyReason, approveBlockedText, approveLabel, conflictNote, headerMenu, submitLabel, watchMode } from '@/lib/decide-flow';
import type { Choice, FlowMode, MenuEntry, MenuKey } from '@/lib/decide-flow';
import { globDiffKey } from '@/lib/live';
import { boardGlobHref } from '@/lib/glob-section';
import { applyPrefill, recommendedLabel, SUGGEST_POLL_MS, SUGGESTION_ACTION_TEXT, suggestionState } from '@/lib/suggestion';

/** A learning an agent submitted or slop mined: the decision is a KB item (same ID), with a knowledge change to apply. */
export const isLearning = (attributes: DecisionAttributes): boolean => attributes.origin.kind === 'submitted' || attributes.origin.kind === 'mined';

/** Suggest: an on-demand model recommendation for the proposal block; its state, stored suggestion and the ask. */
const useSuggest = (glob: GlobView, canSuggest: boolean) => {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Under the `artifact` key, so the live `glob.artifacts` hint that announces the stored suggestion refetches it.
  const suggestion = useQuery({
    queryKey: ['artifact', glob.id, 'suggestion-view'],
    queryFn: () => api.suggestion(glob.id),
    enabled: canSuggest,
    refetchInterval: (query) => (query.state.data?.pending === true ? SUGGEST_POLL_MS : false),
  });
  const state = suggestionState(suggestion.data);
  const ask = () => {
    setBusy(true);
    setFailed(false);
    // The rule-based assessment is free: refresh it first, so the card and the suggestion read the same flags.
    api
      .assess(glob.id)
      .then(() => api.suggest(glob.id))
      .then(() => client.invalidateQueries({ queryKey: ['artifact', glob.id] }))
      .then(() => client.invalidateQueries({ queryKey: ['globs', glob.boardId] }))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  const made = suggestion.data?.suggestion ?? null;
  // A recommendation the rules wrote (no model call) reads as a leaning; with no draft behind it, it is waiting for one.
  const leaning = made?.model === RULES_MODEL ? { waiting: made.stamp.draftVersion === null } : null;
  return { state, stored: made?.suggestion, leaning, prefill: applyPrefill(suggestion.data), error: suggestion.data?.error ?? null, busy, failed, ask };
};

type Suggest = ReturnType<typeof useSuggest>;

export interface FlowMenuItem extends MenuEntry {
  readonly run: () => void;
}

/**
 * The one decide flow of a decision glob: what the header's Approve change and the proposal block's controls both run, so
 * they never disagree. Created once for the glob (see `GlobDetail`) and carried on the glob view's context.
 */
export interface DecideFlow {
  readonly glob: GlobView;
  readonly attributes: DecisionAttributes;
  readonly board: BoardView;
  readonly busy: boolean;
  readonly canDecide: boolean;
  readonly canSuggest: boolean;
  readonly admin: boolean;
  readonly hasItem: boolean;
  readonly learning: DecisionLearning | null;
  readonly target: KbTarget | null;
  readonly draftText: string;
  /** An open learning whose change is still being drafted: nothing to approve yet. */
  readonly waiting: boolean;
  /** The main action: "Approve change" in the header, what it approves in the block. Pressing it again with the approval form open submits it. */
  readonly approve: { readonly label: string; readonly tip: string; readonly blocked: string | null; readonly run: () => void };
  readonly menu: readonly FlowMenuItem[];
  readonly mode: FlowMode | null;
  readonly applied: SuggestionPrefill | null;
  readonly input: DecideInput | null;
  readonly setInput: (input: DecideInput | null) => void;
  readonly submit: () => void;
  readonly close: () => void;
  readonly applySuggestion: (() => void) | null;
  readonly suggest: Suggest;
  readonly formRef: RefObject<HTMLDivElement | null>;
}

/** The decide flow for a decision glob (null for any other, and for a replacement card, which has its own Confirm / Dismiss). */
export const useDecideFlow = ({
  board,
  glob,
  busy,
  onDecide,
}: {
  board: BoardView;
  glob: GlobView;
  busy: boolean;
  onDecide: (input: DecideInput) => Promise<boolean>;
}): DecideFlow | null => {
  const attributes = decisionOf(glob);
  const active = attributes !== null && attributes.origin.kind !== 'replacement';
  const admin = board.role === 'admin';
  const canSuggest = active && (admin || board.role === 'po');
  const diff = useQuery({
    queryKey: globDiffKey(glob.id),
    queryFn: () => api.globDiff(glob.id),
    enabled: active,
    refetchInterval: (query) => {
      const state = query.state.data?.learning;
      return state !== undefined && state !== null && inPipeline(state) ? PIPELINE_POLL_MS : false;
    },
  });
  const suggest = useSuggest(glob, canSuggest);
  const [mode, setMode] = useState<FlowMode | null>(null);
  const [applied, setApplied] = useState<SuggestionPrefill | null>(null);
  const [input, setInput] = useState<DecideInput | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setMode(null);
    setApplied(null);
  }, [glob.id, glob.version]);
  useEffect(() => {
    if (mode === null) setInput(null);
  }, [mode]);
  // A form that has just been chosen (from the header too) comes into view with its first field focused.
  useEffect(() => {
    if (mode === null) return;
    const form = formRef.current;
    form?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    form?.querySelector<HTMLElement>('textarea, input, select')?.focus({ preventScroll: true });
  }, [mode, applied]);
  if (attributes === null || !active) return null;

  const learning: DecisionLearning | null = diff.data?.learning ?? null;
  const target = diff.data?.target ?? null;
  const isDocument = attributes.document !== undefined;
  const hotspot = attributes.origin.kind === 'hotspot';
  const hasItem = isLearning(attributes);
  const canDecide = (glob.allowedActions ?? []).includes('decide');
  const adminOnly = board.role === 'po' ? adminOnlyReason(target?.kind) : null;
  const text = approveLabel(isDocument, target, hotspot);
  const pick = (next: FlowMode) => {
    setApplied(null);
    setMode(next);
  };
  const submit = () => {
    if (input === null) return;
    void onDecide(input).then((done) => {
      if (done) setMode(null);
    });
  };
  const asking = suggest.busy || suggest.state === 'working';
  const run = (key: MenuKey) => {
    if (key === 'suggest') suggest.ask();
    else if (key === 'accept_with_edits' && canSuggest && suggest.state === 'ready' && suggest.prefill?.outcome === 'accept_with_edits') {
      setApplied(suggest.prefill);
      setMode(key);
    } else pick(key);
  };
  const menu = headerMenu({ canDecide, canSuggest, canKeep: admin && hasItem && learning?.status === 'open' && !isDocument, hasItem, adminOnly }).map(
    (entry): FlowMenuItem => ({ ...entry, disabled: entry.key === 'suggest' && asking ? 'The model is already being asked' : entry.disabled, run: () => run(entry.key) }),
  );
  const prefill = suggest.prefill;
  return {
    glob,
    attributes,
    board,
    busy,
    canDecide,
    canSuggest,
    admin,
    hasItem,
    learning,
    target,
    draftText: diff.data?.draft?.content ?? '',
    waiting: hasItem && !isDocument && learning !== null && inPipeline(learning) && diff.data?.draft == null,
    approve: { ...text, blocked: approveBlockedText(adminOnly, canDecide), run: () => (mode === 'accept' ? submit() : pick('accept')) },
    menu,
    mode,
    applied,
    input,
    setInput,
    submit,
    close: () => setMode(null),
    applySuggestion:
      canSuggest && suggest.state === 'ready' && prefill !== null
        ? () => {
            setApplied(prefill);
            setMode(prefill.outcome);
          }
        : null,
    suggest,
    formRef,
  };
};

/** The outcome form for the one choice being made; the block's submit button sends what `onInput` reports. */
const OutcomeForm = ({ flow, choice }: { flow: DecideFlow; choice: Choice }) => {
  const { attributes, draftText, target, applied, admin, learning } = flow;
  const prefill = applied?.outcome === choice ? applied : undefined;
  const [reason, setReason] = useState(prefill?.reason ?? '');
  const [edited, setEdited] = useState(prefill?.editedDraft ?? draftText);
  const [linked, setLinked] = useState('');
  const [kind, setKind] = useState<KnowledgeKind>('doc');
  const [name, setName] = useState('');
  const [section, setSection] = useState('');
  const [watch, setWatch] = useState('');
  // The draft arrives after the form opens when the pipeline is still working; fill it in until the person types.
  const [touched, setTouched] = useState(prefill?.editedDraft !== undefined);
  useEffect(() => {
    if (!touched) setEdited(draftText);
  }, [draftText, touched]);
  const trimmed = reason.trim();
  const inputFor = (): DecideInput => {
    switch (choice) {
      case 'accept_with_edits':
        return { outcome: choice, editedDraft: edited, ...watching(watch) };
      case 'retarget':
        return { outcome: choice, target: { kind, name: name.trim(), section: section.trim() === '' ? null : section.trim() } };
      case 'needs_work':
        return { outcome: choice, ...(linked.trim() === '' ? {} : { linkedGlobId: linked.trim() }), ...(trimmed === '' ? {} : { reason: trimmed }) };
      case 'reject':
        return { outcome: choice, reason: trimmed };
      case 'accept':
        return { outcome: choice, ...watching(watch) };
    }
  };
  const valid = !(
    (choice === 'reject' && trimmed === '') ||
    (choice === 'accept_with_edits' && edited.trim() === '') ||
    (choice === 'retarget' && name.trim() === '')
  );
  const sending = valid ? JSON.stringify(inputFor()) : null;
  const { setInput } = flow;
  useEffect(() => {
    setInput(sending === null ? null : (JSON.parse(sending) as DecideInput));
  }, [sending]);
  // Watching is an admin's step and only offered where the approval records an effect check.
  const watchStep = admin ? watchMode(learning, attributes) : null;
  const whole = target?.kind === 'local_run' || target?.kind === 'merge_policy';
  const editLabel = whole
    ? target.kind === 'merge_policy'
      ? 'Merge policy (JSON, the whole spec)'
      : 'Local-run spec (JSON, the whole spec)'
    : target?.newDocument != null || attributes.document !== undefined
      ? "Edited text (the new document's whole body)"
      : "Edited text (a section's new text)";
  const note = conflictNote(attributes.conflictsWith ?? []);
  return (
    <div className='grid gap-2 rounded border p-3' data-testid={`outcome-form-${choice}`}>
      {choice === 'accept' && (
        <p className='text-xs text-muted-foreground'>
          {!isLearning(attributes)
            ? 'Records the decision as approved; there is no knowledge change to apply.'
            : 'Applies the proposed change to its target, then moves this decision to Reviewing.'}
        </p>
      )}
      {choice === 'accept_with_edits' && (
        <Label>
          {editLabel}
          <Textarea
            className='min-h-40 font-mono text-xs'
            value={edited}
            onChange={(e) => {
              setTouched(true);
              setEdited(e.target.value);
            }}
          />
        </Label>
      )}
      {(choice === 'accept' || choice === 'accept_with_edits') && watchStep !== null && (
        <WatchSignal boardId={flow.glob.boardId} value={watch} onChange={setWatch} own={attributes.signal} />
      )}
      {choice === 'retarget' && (
        <div className='grid grid-cols-3 gap-2'>
          <Label>
            Kind
            <Select value={kind} onChange={(e) => setKind(KNOWLEDGE_KINDS.find((k) => k === e.target.value) ?? kind)}>
              {KNOWLEDGE_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </Select>
          </Label>
          <Label>
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Label>
          <Label>
            Section (optional)
            <Input value={section} onChange={(e) => setSection(e.target.value)} />
          </Label>
        </div>
      )}
      {choice === 'needs_work' && (
        <Label>
          Glob that makes the change (optional: leave blank and slop creates a task for it)
          <Input value={linked} placeholder='s15t7' onChange={(e) => setLinked(e.target.value)} />
        </Label>
      )}
      {(choice === 'reject' || choice === 'needs_work') && (
        <Label>
          {choice === 'reject' ? 'Reason (required)' : 'Why it needs work (optional)'}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Label>
      )}
      {choice === 'reject' && note !== null && (
        <p className='text-xs text-amber-800 dark:text-amber-200' data-testid='conflict-note-reject'>
          {note}: say why this one should go.
        </p>
      )}
    </div>
  );
};

/** Slop's recommendation, one line: what it recommends and why. The rule-based assessments and older suggestions are not repeated here. */
export const Recommendation = ({ glob, suggest }: { glob: GlobView; suggest: Suggest }) => {
  const { state, stored } = suggest;
  const text = stored?.editedDraft ?? stored?.mergedText ?? null;
  return (
    <div className='grid gap-1' data-testid='recommendation'>
      {state === 'working' && (
        <p className='text-xs text-muted-foreground' data-testid='suggest-working'>
          {suggest.error === null ? 'Getting a recommendation…' : suggest.error}
        </p>
      )}
      {suggest.failed && <p className='text-xs text-red'>Could not get a recommendation.</p>}
      {stored !== undefined && (
        <div className='grid gap-1 text-sm' data-testid='suggestion'>
          <p className='whitespace-pre-wrap break-words'>
            <span className='font-medium'>
              {suggest.leaning === null
                ? `Recommends: ${SUGGESTION_ACTION_TEXT[stored.action]}.`
                : `Leaning: ${SUGGESTION_ACTION_TEXT[stored.action]}${suggest.leaning.waiting ? ', waiting for the draft' : ''}.`}
            </span>{' '}
            {stored.reason}
            {stored.mergeInto !== null && (
              <>
                {' '}
                <Link className='font-mono text-xs underline' to={boardGlobHref(glob.boardId, stored.mergeInto, { section: 'decision' })}>
                  {stored.mergeInto}
                </Link>
              </>
            )}
          </p>
          {state === 'stale' && (
            <span className='w-fit rounded bg-amber-500/15 px-1.5 text-xs text-amber-800 dark:text-amber-200' data-testid='suggestion-stale'>
              Stale: the draft or its target changed since; get a new recommendation
            </span>
          )}
          {text !== null && (
            <details className='text-xs'>
              <summary className='cursor-pointer text-muted-foreground'>{stored.action === 'merge_into' ? 'Combined text for the other learning' : 'Suggested wording'}</summary>
              <pre className='mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono'>{text}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

/** What the main button of the outcome controls is and does for the flow's current state. */
const mainState = (flow: DecideFlow) => {
  const { mode, approve, busy, input, suggest } = flow;
  const outcomeMode = mode !== null && mode !== 'keep' ? mode : null;
  // Both accept modes carry the admin-only check (a PO can reach accept-with-edits through Apply suggestion); the other outcomes need only decide.
  const acceptMode = outcomeMode === null || outcomeMode === 'accept' || outcomeMode === 'accept_with_edits';
  // The primary button is the recommended outcome; an approval is just the default.
  const recommended = outcomeMode === null && flow.applySuggestion !== null && suggest.stored !== undefined && suggest.stored.action !== 'approve';
  // A recommended reject or merge is not an approval: it needs only decide, as in the ▾.
  const blocked = acceptMode && !(recommended && suggest.prefill?.outcome === 'reject') ? approve.blocked : flow.canDecide ? null : "You can't decide this";
  const label = outcomeMode !== null ? submitLabel(outcomeMode, approve.label) : recommended ? recommendedLabel(suggest.stored, approve.label) : approve.label;
  const off = busy || blocked !== null || (outcomeMode !== null && input === null);
  const apply = flow.applySuggestion;
  const press = () => (recommended && apply !== null ? apply() : outcomeMode === null || mode === 'keep' ? approve.run() : flow.submit());
  return { outcomeMode, blocked, label, off, press };
};

const MenuItems = ({ flow, only }: { flow: DecideFlow; only?: MenuKey }) => (
  <>
    {flow.menu
      .filter((item) => only === undefined || item.key === only)
      .map((item) => (
        <DropdownMenuItem key={item.key} disabled={item.disabled !== null} data-testid={item.key === 'suggest' ? 'suggest' : `outcome-${item.key}`} onSelect={item.run}>
          <span className='grid'>
            <span className='font-medium'>{item.label}</span>
            <span className='text-xs text-muted-foreground'>{item.disabled ?? item.tip}</span>
          </span>
        </DropdownMenuItem>
      ))}
  </>
);

export const WAITING_FOR_DRAFT = 'Waiting for the draft';

/**
 * A learning's outcome as the glob's main action in the action row under the title: the recommended outcome (else Approve)
 * with the other outcomes in the ▾. While the change is still being drafted it is a disabled "Waiting for the draft" and
 * the ▾ holds only Reject…. With a form open the button becomes that form's submit (Save, Reject…) beside a Cancel.
 * `extra` is the row's other actions, which follow the outcomes in the ▾.
 */
export const DecisionMainAction = ({ flow, extra }: { flow: DecideFlow; extra?: ReactNode }) => {
  const { mode, busy, waiting, attributes } = flow;
  const { outcomeMode, blocked, label, off, press } = mainState(flow);
  const holding = waiting && mode === null;
  const keeping = mode === 'keep';
  const note = conflictNote(attributes.conflictsWith ?? []);
  return (
    <>
      <div className='inline-flex' data-testid='split-button'>
        <Tip text={holding ? 'The change is still being drafted; there is nothing to approve yet' : (blocked ?? (outcomeMode === 'accept_with_edits' ? 'Saves your wording and approves the change' : flow.approve.tip))}>
          <Button
            size='sm'
            className='rounded-r-none'
            disabled={off || holding || keeping}
            data-testid='main-action'
            data-outcome={outcomeMode ?? 'accept'}
            onClick={press}
          >
            {holding ? WAITING_FOR_DRAFT : keeping ? 'Approving without a document' : label}
          </Button>
        </Tip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size='sm' className='rounded-l-none border-l-primary-foreground/40 px-1.5' disabled={busy} aria-label='More actions' data-testid='more-actions'>
              <ChevronDown className='size-3.5' aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' data-testid='more-menu'>
            <MenuItems flow={flow} {...(holding ? { only: 'reject' as const } : {})} />
            {extra}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {mode !== null && !keeping && (
        <Button size='sm' variant='ghost' data-testid='outcome-clear' onClick={flow.close}>
          Cancel
        </Button>
      )}
      {blocked !== null && (
        <span className='text-xs text-muted-foreground' data-testid='approve-blocked'>
          {blocked}
        </span>
      )}
      {note !== null && (
        <span className='text-xs text-amber-800 dark:text-amber-200' data-testid='conflict-note'>
          {note}
        </span>
      )}
    </>
  );
};

/** The form of the outcome the action row opened (reject reason, the edited wording, retarget…), in the body: fields only, the row's button submits it. */
export const OutcomeForms = ({ flow }: { flow: DecideFlow }) => {
  const { mode, glob, attributes, busy } = flow;
  if (mode === null) return null;
  return (
    <div ref={flow.formRef} data-testid='outcome-forms'>
      {mode === 'keep' ? (
        <KeepAsLearning key={`${glob.id}-${String(glob.version)}`} glob={glob} attributes={attributes} learning={flow.learning} busy={busy} onClose={flow.close} />
      ) : (
        <OutcomeForm key={`${mode}-${flow.applied?.outcome === mode ? 'applied' : 'plain'}`} flow={flow} choice={mode} />
      )}
    </div>
  );
};

/**
 * The outcome controls at the foot of the proposal block: one primary button (the recommended outcome, else Approve), the
 * other outcomes in the ▾ and the chosen outcome's form beneath. The block holds the learning's only Approve.
 */
export const Outcomes = ({ flow }: { flow: DecideFlow }) => {
  const { mode, approve, glob, attributes, busy } = flow;
  const { outcomeMode, blocked, label: mainLabel, off: mainOff, press } = mainState(flow);
  const note = conflictNote(attributes.conflictsWith ?? []);
  return (
    <div className='grid gap-2' data-testid='outcomes'>
      <div className='flex flex-wrap items-center gap-2' role='group' aria-label='Outcome'>
        <div className='flex'>
          <Tip text={blocked ?? (outcomeMode === 'accept_with_edits' ? 'Saves your wording and approves the change' : approve.tip)}>
            <Button
              size='sm'
              className='rounded-r-none'
              disabled={mainOff}
              data-testid={`outcome-${outcomeMode ?? 'accept'}`}
              onClick={press}
            >
              {mainLabel}
            </Button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='sm' className='rounded-l-none border-l-primary-foreground/40 px-1.5' disabled={busy} aria-label='More outcomes' data-testid='more-outcomes'>
                <ChevronDown className='size-3.5' aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start' data-testid='outcomes-menu'>
              <MenuItems flow={flow} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {mode !== null && (
          <Button size='sm' variant='ghost' data-testid='outcome-clear' onClick={flow.close}>
            Cancel
          </Button>
        )}
        {blocked !== null && (
          <span className='text-xs text-muted-foreground' data-testid='approve-blocked'>
            {blocked}
          </span>
        )}
        {note !== null && (
          <span className='text-xs text-amber-800 dark:text-amber-200' data-testid='conflict-note'>
            {note}
          </span>
        )}
      </div>
      {mode !== null && (
        <div ref={flow.formRef}>
          {mode === 'keep' ? (
            <KeepAsLearning key={`${glob.id}-${String(glob.version)}`} glob={glob} attributes={attributes} learning={flow.learning} busy={busy} onClose={flow.close} />
          ) : (
            <OutcomeForm key={`${mode}-${flow.applied?.outcome === mode ? 'applied' : 'plain'}`} flow={flow} choice={mode} />
          )}
        </div>
      )}
    </div>
  );
};
