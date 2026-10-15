import { decisionOf, KNOWLEDGE_KINDS } from '@slop/core';
import type { DecisionAttributes, DecisionLearning, KbTarget, KnowledgeKind, SuggestionPrefill } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router';
import { KeepAsLearning, inPipeline, PIPELINE_POLL_MS, WatchSignal, watching } from '@/components/decision-learning';
import { CollapsibleMarkdown } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Tip } from '@/components/ui/tip';
import { api } from '@/lib/api';
import type { BoardView, DecideInput, GlobView } from '@/lib/api';
import { adminOnlyReason, approveBlockedText, approveLabel, conflictNote, headerMenu, submitLabel, watchMode } from '@/lib/decide-flow';
import type { Choice, FlowMode, MenuEntry, MenuKey } from '@/lib/decide-flow';
import { artifactKey, globDiffKey } from '@/lib/live';
import { boardGlobHref } from '@/lib/glob-section';
import { APPLY_HINT_TEXT, applyPrefill, SUGGEST_POLL_MS, SUGGESTION_ACTION_TEXT, suggestionState } from '@/lib/suggestion';

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
  return { state, stored: suggestion.data?.suggestion?.suggestion, prefill: applyPrefill(suggestion.data), error: suggestion.data?.error ?? null, busy, failed, ask };
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
    else pick(key);
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

/** The latest assessment and suggestion, read before deciding. */
export const LatestAssessment = ({ glob, suggest, canSuggest }: { glob: GlobView; suggest: Suggest; canSuggest: boolean }) => {
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment' && a.label === '');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', ''),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', ''),
    enabled: has,
  });
  const latest = versions.data?.at(-1);
  const { state, stored } = suggest;
  const text = stored?.editedDraft ?? stored?.mergedText ?? null;
  return (
    <div className='grid gap-2' data-testid='assessment'>
      {latest !== undefined && (
        <div className='rounded border p-3'>
          <CollapsibleMarkdown content={latest.content} />
        </div>
      )}
      {latest === undefined && has && <p className='text-sm text-muted-foreground'>Loading…</p>}
      {canSuggest && state === 'working' && (
        <p className='text-xs text-muted-foreground' data-testid='suggest-working'>
          {suggest.error === null ? 'Asking the model…' : suggest.error}
        </p>
      )}
      {suggest.failed && <p className='text-xs text-red'>Could not ask for a suggestion.</p>}
      {canSuggest && stored !== undefined && (
        <div className='grid gap-2 rounded border border-edge p-3' data-testid='suggestion'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='rounded bg-muted px-2 py-0.5 text-xs font-medium'>{SUGGESTION_ACTION_TEXT[stored.action]}</span>
            {state === 'stale' && (
              <span className='rounded bg-amber-500/15 px-1.5 text-xs text-amber-800 dark:text-amber-200' data-testid='suggestion-stale'>
                Stale: the draft or its target changed since; suggest again
              </span>
            )}
            {stored.mergeInto !== null && (
              <Link className='font-mono text-xs underline' to={boardGlobHref(glob.boardId, stored.mergeInto, { section: 'decision' })}>
                {stored.mergeInto}
              </Link>
            )}
          </div>
          <p className='whitespace-pre-wrap break-words text-sm'>{stored.reason}</p>
          {text !== null && (
            <details className='text-xs'>
              <summary className='cursor-pointer text-muted-foreground'>{stored.action === 'merge_into' ? 'Combined text for the other learning' : 'Edited text'}</summary>
              <pre className='mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono'>{text}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * The outcome controls at the foot of the proposal block: Approve (what it approves), Reject… and the other outcomes in
 * the ▾, the chosen outcome's form beneath, and Suggest's Apply. The same flow drives the header's Approve change.
 */
export const Outcomes = ({ flow }: { flow: DecideFlow }) => {
  const { mode, approve, glob, attributes, busy, input, suggest } = flow;
  const outcomeMode = mode !== null && mode !== 'keep' ? mode : null;
  // Both accept modes carry the admin-only check (a PO can reach accept-with-edits through Apply suggestion); the other outcomes need only decide.
  const acceptMode = outcomeMode === null || outcomeMode === 'accept' || outcomeMode === 'accept_with_edits';
  const blocked = acceptMode ? approve.blocked : flow.canDecide ? null : "You can't decide this";
  const mainLabel = outcomeMode === null ? approve.label : submitLabel(outcomeMode, approve.label);
  const mainOff = busy || blocked !== null || (outcomeMode !== null && input === null);
  const note = conflictNote(attributes.conflictsWith ?? []);
  const merge = suggest.stored?.action === 'merge_into';
  return (
    <div className='grid gap-2' data-testid='outcomes'>
      <div className='flex flex-wrap items-center gap-2' role='group' aria-label='Outcome'>
        <div className='flex'>
          <Tip text={blocked ?? approve.tip}>
            <Button
              size='sm'
              className='rounded-r-none'
              disabled={mainOff}
              data-testid={`outcome-${outcomeMode ?? 'accept'}`}
              onClick={() => (outcomeMode === null || mode === 'keep' ? approve.run() : flow.submit())}
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
              {flow.menu.map((item) => (
                <DropdownMenuItem key={item.key} disabled={item.disabled !== null} data-testid={item.key === 'suggest' ? 'suggest' : `outcome-${item.key}`} onSelect={item.run}>
                  <span className='grid'>
                    <span className='font-medium'>{item.label}</span>
                    <span className='text-xs text-muted-foreground'>{item.disabled ?? item.tip}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {mode !== null && (
          <Button size='sm' variant='ghost' data-testid='outcome-clear' onClick={flow.close}>
            Cancel
          </Button>
        )}
        {flow.applySuggestion !== null && (
          <Tip text={APPLY_HINT_TEXT}>
            <Button size='sm' variant='outline' disabled={busy} data-testid='apply-suggestion' onClick={flow.applySuggestion}>
              {merge ? `Apply: reject, merged into ${suggest.stored?.mergeInto ?? 'another learning'}` : 'Apply suggestion'}
            </Button>
          </Tip>
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
