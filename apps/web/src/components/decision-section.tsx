import { decisionOf, isAgentSetKind, KNOWLEDGE_KINDS, SCOPE_KINDS, scopeLabel } from '@slop/core';
import type { DecisionAttributes, DecisionLearning, DecisionOutcomeKind, DecisionScope, EditFailure, KbTarget, KnowledgeKind, ScopeKind, SuggestionPrefill } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DiffView } from '@/components/diff-view';
import {
  canWatch,
  DocumentProposal,
  EffectCheckView,
  inPipeline,
  KeepAsLearning,
  PIPELINE_POLL_MS,
  ProcessingState,
  SignalFigures,
  StaleNote,
  WatchSignal,
  watching,
} from '@/components/decision-learning';
import { MarkdownView } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { closedText, LINK_TEXT, linksByKind, targetText } from '@/lib/decision-links';
import { applyPrefill, SUGGEST_POLL_MS, SUGGESTION_ACTION_TEXT, suggestionState } from '@/lib/suggestion';
import { artifactKey, globDecisionsKey, globDiffKey } from '@/lib/live';
import { useToast } from '@/toast';
import { Tip } from './ui/tip';

/** A learning an agent submitted or slop mined: the decision is a KB item (same ID), with a knowledge change to apply. */
const isLearning = (attributes: DecisionAttributes): boolean => attributes.origin.kind === 'submitted' || attributes.origin.kind === 'mined';

type Choice = Exclude<DecisionOutcomeKind, 'closed'>;

const CHOICES: readonly { readonly outcome: Choice; readonly label: string; readonly tip: string }[] = [
  { outcome: 'accept', label: 'Accept', tip: 'Apply the proposed change as drafted' },
  { outcome: 'accept_with_edits', label: 'Accept with edits', tip: 'Apply the change with your own wording' },
  { outcome: 'retarget', label: 'Retarget', tip: 'Point the proposal at another document or file; it is drafted again' },
  { outcome: 'needs_work', label: 'Needs work', tip: 'Some work has to land first; the decision waits for it to merge' },
  { outcome: 'reject', label: 'Reject', tip: 'Turn the proposal down, with a reason' },
];

export const OUTCOME_TEXT: Record<DecisionOutcomeKind, string> = {
  accept: 'Accepted',
  accept_with_edits: 'Accepted with edits',
  retarget: 'Retargeted',
  needs_work: 'Needs work',
  reject: 'Rejected',
  closed: 'Closed by the pipeline',
};

const SCOPE_TEXT: Record<ScopeKind, string> = {
  glob: 'One glob',
  future_work: 'Future work',
  area_group: 'A group',
  project: 'The whole project',
};

/** What the scope's reference means for each kind: null when the kind takes none. */
const REF_HINT: Record<ScopeKind, string | null> = {
  glob: 'Glob ID, e.g. s15t7',
  future_work: 'Group (optional)',
  area_group: 'Group name',
  project: null,
};

/** What Accept is called for this proposal, and what it does. */
const acceptText = (document: boolean, target: KbTarget | null): { label: string; tip: string } => {
  if (document) return { label: 'Approve document', tip: 'Create or update the proposed document (whole documents always need a person)' };
  if (target?.kind === 'merge_policy') return { label: 'Approve merge policy', tip: 'Replace the merge policy with the proposed one' };
  if (target?.kind === 'local_run') return { label: 'Approve local-run spec', tip: 'Replace the local-run spec with the proposed one' };
  return { label: 'Accept', tip: 'Apply the proposed change as drafted' };
};

/** Why a PO may not decide a change to this target (as core refuses it), or null. Agent behaviour and what slop runs or enforces are for admins. */
const adminOnlyReason = (kind: KnowledgeKind | undefined): string | null => {
  if (kind === undefined) return null;
  if (isAgentSetKind(kind)) return 'changes an agent-set file, which changes how agents behave';
  if (kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  return null;
};

const when = (iso: string) => new Date(iso).toLocaleString();

/** The scope as the form builds it: a blank reference is none. */
export const scopeFrom = (kind: ScopeKind, ref: string): DecisionScope => {
  const text = ref.trim();
  switch (kind) {
    case 'glob':
      return { kind, ref: text };
    case 'area_group':
      return { kind, ref: text };
    case 'future_work':
      return { kind, ref: text === '' ? null : text };
    case 'project':
      return { kind, ref: null };
  }
};

const ScopeEditor = ({
  glob,
  attributes,
  busy,
  onUpdate,
}: {
  glob: GlobView;
  attributes: DecisionAttributes;
  busy: boolean;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
}) => {
  const [kind, setKind] = useState<ScopeKind>(attributes.scope.kind);
  const [ref, setRef] = useState(attributes.scope.ref ?? '');
  const [failure, setFailure] = useState<EditFailure | null>(null);
  useEffect(() => {
    setKind(attributes.scope.kind);
    setRef(attributes.scope.ref ?? '');
    setFailure(null);
  }, [glob.id, attributes.scope.kind, attributes.scope.ref]);
  const next = scopeFrom(kind, ref);
  const changed = next.kind !== attributes.scope.kind || next.ref !== attributes.scope.ref;
  const hint = REF_HINT[kind];
  return (
    <div className='grid gap-2' data-testid='scope-editor'>
      <div className='grid grid-cols-[auto_1fr_auto] items-end gap-2'>
        <Label>
          Scope
          <Select
            value={kind}
            data-testid='scope-kind'
            onChange={(e) => {
              setKind(SCOPE_KINDS.find((k) => k === e.target.value) ?? kind);
              setFailure(null);
            }}
          >
            {SCOPE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SCOPE_TEXT[k]}
              </option>
            ))}
          </Select>
        </Label>
        {hint === null ? <span /> : <Input aria-label='Scope reference' value={ref} placeholder={hint} onChange={(e) => setRef(e.target.value)} />}
        <Button
          size='sm'
          variant='outline'
          disabled={busy || !changed}
          data-testid='save-scope'
          onClick={() => void onUpdate({ attributes: { scope: next } }).then(setFailure)}
        >
          Save scope
        </Button>
      </div>
      {failure !== null && (
        <p role='alert' className='text-xs text-red'>
          {failure.message}
        </p>
      )}
    </div>
  );
};

/** The outcome form for the one choice being made; `onDecide` resolves false when the server refused it. */
const OutcomeForm = ({
  choice,
  attributes,
  boardId,
  busy,
  draftText,
  target,
  watchable,
  prefill,
  onCancel,
  onDecide,
}: {
  choice: Choice;
  attributes: DecisionAttributes;
  boardId: number;
  busy: boolean;
  draftText: string;
  /** Where the change goes: a spec (merge policy, local-run) is replaced whole, a new document's body is its content. */
  target: KbTarget | null;
  /** The learning can be given a signal to watch on approval. */
  watchable: boolean;
  /** Suggest's Apply: the form opens with these filled in; nothing is decided until the person confirms. */
  prefill?: SuggestionPrefill | undefined;
  onCancel: () => void;
  onDecide: (input: DecideInput) => Promise<boolean>;
}) => {
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
  const send = (input: DecideInput) => void onDecide(input).then((done) => done && onCancel());
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
  const whole = target?.kind === 'local_run' || target?.kind === 'merge_policy';
  const editLabel = whole
    ? target.kind === 'merge_policy'
      ? 'Merge policy (JSON, the whole spec)'
      : 'Local-run spec (JSON, the whole spec)'
    : target?.newDocument != null || attributes.document !== undefined
      ? "Edited text (the new document's whole body)"
      : "Edited text (a section's new text)";
  return (
    <div className='grid gap-2 rounded border p-3' data-testid={`outcome-form-${choice}`}>
      {choice === 'accept' && (
        <p className='text-xs text-muted-foreground'>
          {!isLearning(attributes)
            ? 'Records the decision as accepted; there is no knowledge change to apply.'
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
      {(choice === 'accept' || choice === 'accept_with_edits') && watchable && <WatchSignal boardId={boardId} value={watch} onChange={setWatch} />}
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
      <div className='flex justify-end gap-2'>
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size='sm'
          variant={choice === 'reject' ? 'destructive' : 'default'}
          data-testid='confirm-outcome'
          disabled={
            busy ||
            (choice === 'reject' && trimmed === '') ||
            (choice === 'accept_with_edits' && edited.trim() === '') ||
            (choice === 'retarget' && name.trim() === '')
          }
          onClick={() => send(inputFor())}
        >
          {CHOICES.find((c) => c.outcome === choice)?.label}
        </Button>
      </div>
    </div>
  );
};

/** The proposed change: its target and the diff of what accepting it would do to it. */
const ProposedChange = ({ globId }: { globId: string }) => {
  const diff = useQuery({ queryKey: globDiffKey(globId), queryFn: () => api.globDiff(globId) });
  if (diff.isError) return <p className='text-sm text-red'>Could not load the proposed change.</p>;
  if (diff.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the proposed change…</p>;
  const { target, preview } = diff.data;
  return (
    <div className='grid gap-1' data-testid='proposed-change'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Proposed change</h3>
      {target !== null && (
        <p className='text-xs text-muted-foreground'>
          Target: <span className='font-mono'>{target.kind}:{target.name}</span>
          {target.section !== null && <> · section “{target.section}”</>}
        </p>
      )}
      {preview === null ? (
        <p className='text-sm text-muted-foreground' data-testid='no-change'>
          No proposed change yet{target === null ? ': it has no target' : ': it is still being drafted'}.
        </p>
      ) : (
        <>
          {preview.stale && (
            <span className='w-fit rounded bg-amber-500/15 px-1.5 text-xs text-amber-800 dark:text-amber-200'>
              Stale draft: the target changed since it was drafted; it is being drafted again
            </span>
          )}
          <DiffView lines={preview.diff} />
        </>
      )}
    </div>
  );
};

/**
 * The assessment slop wrote about the proposal (what it changes, flags, the rule-based outcome), beside the review
 * section, and Suggest: an on-demand model recommendation. Apply opens the decide form pre-filled (`onApply`); nothing is
 * decided without the person's confirmation there.
 */
export const DecisionAssessment = ({
  glob,
  canSuggest,
  onApply,
}: {
  glob: GlobView;
  /** Admins and POs ask for suggestions. */
  canSuggest: boolean;
  onApply: (prefill: SuggestionPrefill) => void;
}) => {
  const client = useQueryClient();
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment' && a.label === '');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', ''),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', ''),
    enabled: has,
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = versions.data?.at(-1);
  // Under the `artifact` key, so the live `glob.artifacts` hint that announces the stored suggestion refetches it.
  const suggestion = useQuery({
    queryKey: ['artifact', glob.id, 'suggestion-view'],
    queryFn: () => api.suggestion(glob.id),
    enabled: canSuggest,
    refetchInterval: (query) => (query.state.data?.pending === true ? SUGGEST_POLL_MS : false),
  });
  const state = suggestionState(suggestion.data);
  const stored = suggestion.data?.suggestion?.suggestion;
  const prefill = applyPrefill(suggestion.data);
  const text = stored?.editedDraft ?? stored?.mergedText ?? null;
  return (
    <div className='grid gap-2' data-testid='assessment'>
      <div className='flex items-center gap-2'>
        <h3 className='text-xs font-semibold text-muted-foreground'>Assessment</h3>
        {canSuggest && (
          <Tip text='Ask the model what to do with this: approve, approve with an edit, merge into another learning, or reject. It reads the draft, the target section, the sibling learnings and the changes merged since'>
            <Button
              size='sm'
              variant='outline'
              disabled={busy || state === 'working'}
              data-testid='suggest'
              onClick={() => {
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
              }}
            >
              {state === 'working' ? 'Suggesting…' : state === 'none' ? 'Suggest' : 'Suggest again'}
            </Button>
          </Tip>
        )}
        {failed && <span className='text-xs text-red'>Could not ask for a suggestion.</span>}
      </div>
      {latest === undefined ? (
        <p className='text-sm text-muted-foreground'>{has ? 'Loading…' : 'Not assessed yet.'}</p>
      ) : (
        <div className='rounded border p-3'>
          <MarkdownView content={latest.content} />
        </div>
      )}
      {canSuggest && state === 'working' && (
        <p className='text-xs text-muted-foreground' data-testid='suggest-working'>
          {suggestion.data?.error == null ? 'Asking the model…' : suggestion.data.error}
        </p>
      )}
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
              <Link className='font-mono text-xs underline' to={`/boards/${String(glob.boardId)}?glob=${encodeURIComponent(stored.mergeInto)}`}>
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
          {prefill !== null && (
            <div className='flex items-center gap-2'>
              <Button size='sm' data-testid='apply-suggestion' onClick={() => onApply(prefill)}>
                {stored.action === 'merge_into' ? `Apply: reject, merged into ${stored.mergeInto ?? 'another learning'}` : 'Apply'}
              </Button>
              <span className='text-xs text-muted-foreground'>Opens the decision below, filled in. You confirm it.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const day = (iso: string) => iso.slice(0, 10);

/** One of the two choices a replacement card compares: what was chosen, where, when and by whom, and the words it rests on. */
const ChoiceColumn = ({ heading, statement, quote, sourceLabel, sourceUrl, decidedAt, decidedBy, matched }: {
  heading: string;
  statement: string;
  quote?: string;
  sourceLabel: string;
  sourceUrl: string | null;
  decidedAt: string;
  decidedBy?: string | null;
  matched: string | null;
}) => (
  <div className='grid content-start gap-1 rounded border p-2 text-xs' data-testid='replacement-choice'>
    <h4 className='font-semibold text-muted-foreground'>{heading}</h4>
    <p className='whitespace-pre-wrap break-words'>{statement}</p>
    <p className='text-[11px] text-muted-foreground'>
      {sourceUrl === null ? sourceLabel : <Link className='underline' to={sourceUrl}>{sourceLabel}</Link>} · {day(decidedAt)}
      {decidedBy == null ? '' : ` · ${decidedBy}`}
    </p>
    {quote !== undefined && <blockquote className='whitespace-pre-wrap break-words border-l-2 pl-2 text-[11px] text-muted-foreground'>{quote}</blockquote>}
    {matched !== null && matched !== '' && <p className='text-[11px] text-muted-foreground'>Slop matched: “{matched}”</p>}
  </div>
);

/**
 * A replacement card: "did this newer choice replace that older one?". The two choices side by side (with their sources,
 * dates and quotes) and the model's reason, with Confirm and Dismiss for an admin or PO until it is decided. Choice text
 * comes from documents and models, so it is plain text.
 */
const ReplacementCard = ({ board, glob, attributes }: { board: BoardView; glob: GlobView; attributes: DecisionAttributes }) => {
  const client = useQueryClient();
  const toast = useToast();
  const origin = attributes.origin.kind === 'replacement' ? attributes.origin : null;
  const scopeGlob = attributes.scope.kind === 'glob' ? attributes.scope.ref : null;
  // The older choice's glob lists both choices; a project-scope one (older choice from an approved learning) has no glob to read them from.
  const choices = useQuery({
    queryKey: globDecisionsKey(scopeGlob ?? ''),
    queryFn: () => api.decisions(glob.boardId, scopeGlob ?? ''),
    enabled: scopeGlob !== null,
  });
  const older = choices.data?.decisions.find((d) => d.id === origin?.oldId);
  const newer = older?.replacedBy ?? null;
  const decide = useMutation({
    mutationFn: (outcome: 'confirm' | 'dismiss') => api.decideReplacement(glob.boardId, glob.id, outcome),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['globs', glob.boardId] });
      void client.invalidateQueries({ queryKey: globDecisionsKey(scopeGlob ?? '') });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save'),
  });
  const open = glob.status !== 'signed_off';
  const deciders = board.role === 'admin' || board.role === 'po';
  const outcome = attributes.outcome;
  return (
    <section className='grid gap-3 rounded border border-edge p-3' data-testid='decision-section'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <span className='rounded bg-muted px-2 py-0.5' data-testid='decision-scope'>
          Applies to {scopeLabel(attributes.scope)}
        </span>
        <span className='text-muted-foreground'>an unverified replacement</span>
      </div>
      {older !== undefined && newer !== null ? (
        <div className='grid gap-2 sm:grid-cols-2' data-testid='replacement-choices'>
          <ChoiceColumn
            heading='Older choice'
            statement={older.statement}
            quote={older.quote}
            sourceLabel={older.sourceLabel}
            sourceUrl={older.sourceUrl}
            decidedAt={older.decidedAt}
            decidedBy={older.decidedBy}
            matched={newer.oldQuote}
          />
          <ChoiceColumn
            heading='Newer choice'
            statement={newer.statement}
            sourceLabel={newer.sourceLabel}
            sourceUrl={newer.sourceUrl}
            decidedAt={newer.decidedAt}
            matched={newer.newQuote}
          />
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>The two choices are in the proposal above.</p>
      )}
      {newer?.reason != null && newer.reason !== '' && (
        <p className='text-xs' data-testid='replacement-reason'>
          <span className='font-medium'>Why slop thinks so:</span> {newer.reason}
        </p>
      )}
      {outcome !== null && (
        <p className='text-sm' data-testid='decision-outcome'>
          <span className='font-medium'>{outcome.kind === 'accept' ? 'Confirmed' : outcome.kind === 'reject' ? 'Dismissed' : 'Closed: no longer relevant'}</span>
          {outcome.kind !== 'closed' && <> by {outcome.by}</>} on {when(outcome.at)}
          {outcome.reason !== undefined && outcome.kind !== 'closed' && <>: {outcome.reason}</>}
        </p>
      )}
      {open && deciders && (
        <div className='flex flex-wrap gap-2' data-testid='replacement-outcomes'>
          <Tip text='The newer choice replaces the older one: the older one stops being in force'>
            <Button size='sm' disabled={decide.isPending} data-testid='replacement-confirm' onClick={() => decide.mutate('confirm')}>
              Confirm
            </Button>
          </Tip>
          <Tip text='Keep both choices in force; this pair is never proposed again'>
            <Button size='sm' variant='outline' disabled={decide.isPending} data-testid='replacement-dismiss' onClick={() => decide.mutate('dismiss')}>
              Dismiss
            </Button>
          </Tip>
        </div>
      )}
    </section>
  );
};

/** What a learning is: its kind, target and evidence, how the pipeline closed it, and how it relates to other learnings. */
const LearningFacts = ({ glob, attributes, deciders }: { glob: GlobView; attributes: DecisionAttributes; deciders: boolean }) => {
  const target = targetText(attributes);
  const closed = closedText(attributes);
  const groups = linksByKind(glob.links);
  const open = (id: string) => `/boards/${String(glob.boardId)}?glob=${encodeURIComponent(id)}`;
  return (
    <div className='grid gap-1 text-xs' data-testid='learning-facts'>
      <p className='text-muted-foreground'>
        {attributes.kind ?? 'learning'}
        {target === null ? '' : ` → ${target}`}
        {attributes.evidenceCount === undefined ? '' : ` · ${String(attributes.evidenceCount)} occurrence(s)`}
        {attributes.stale?.since != null ? ' · flagged stale' : ''}
      </p>
      {closed !== null && <p data-testid='learning-closed'>{closed}{deciders ? '. An admin can reopen it.' : '.'}</p>}
      {groups.map(({ kind, ids }) => (
        <p key={kind} data-testid={`learning-links-${kind}`}>
          {LINK_TEXT[kind]}{' '}
          {ids.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link className='font-mono underline' to={open(id)}>
                {id}
              </Link>
            </span>
          ))}
        </p>
      ))}
      {deciders && <p className='text-muted-foreground'>A learning is never deleted: reject it instead, so it suppresses its repeats.</p>}
    </div>
  );
};

/**
 * What a decision glob shows in place of a work glob's branch, PR and runs: its scope, the proposed change with its diff, the
 * conflict flag, the outcome so far and (for an admin or PO with it in Doing) the five outcomes.
 */
export const DecisionSection = ({
  board,
  glob,
  busy,
  onDecide,
  onUpdate,
  applied,
}: {
  board: BoardView;
  glob: GlobView;
  busy: boolean;
  onDecide: (input: DecideInput) => Promise<boolean>;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  /** Suggest's Apply: opens the form for its outcome, pre-filled. */
  applied?: SuggestionPrefill | null;
}) => {
  const attributes = decisionOf(glob);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => setChoice(null), [glob.id, glob.version]);
  useEffect(() => {
    if (applied != null) setChoice(applied.outcome);
  }, [applied]);
  const diff = useQuery({
    queryKey: globDiffKey(glob.id),
    queryFn: () => api.globDiff(glob.id),
    // Routing and drafting run in the background and hints report each step; while one is due, also check now and then in case a hint was lost.
    refetchInterval: (query) => {
      const state = query.state.data?.learning;
      return state !== undefined && state !== null && inPipeline(state) ? PIPELINE_POLL_MS : false;
    },
  });
  if (attributes === null) return null;
  if (attributes.origin.kind === 'replacement') return <ReplacementCard board={board} glob={glob} attributes={attributes} />;
  const admin = board.role === 'admin';
  const deciders = admin || board.role === 'po';
  const learning: DecisionLearning | null = diff.data?.learning ?? null;
  const target = diff.data?.target ?? null;
  const isDocument = attributes.document !== undefined;
  const accept = acceptText(isDocument, target);
  const adminOnly = board.role === 'po' ? adminOnlyReason(target?.kind) : null;
  const canDecide = (glob.allowedActions ?? []).includes('decide');
  const conflicts = attributes.conflictsWith ?? [];
  const outcome = attributes.outcome;
  const hasItem = isLearning(attributes);
  return (
    <section className='grid gap-3 rounded border border-edge p-3' data-testid='decision-section'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <span className='rounded bg-muted px-2 py-0.5' data-testid='decision-scope'>
          Applies to {scopeLabel(attributes.scope)}
        </span>
        <span className='text-muted-foreground'>via {attributes.channel}</span>
        {conflicts.length > 0 && (
          <Tip text='This decision contradicts a decision with a broader scope, which wins where they disagree'>
            <span className='rounded bg-amber-500/15 px-1.5 text-amber-800 dark:text-amber-200' data-testid='conflicts-chip'>
              Conflicts with{' '}
              {conflicts.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <Link className='font-mono underline' to={`/boards/${String(glob.boardId)}?glob=${encodeURIComponent(id)}`}>
                    {id}
                  </Link>
                </span>
              ))}{' '}
              (broader scope)
            </span>
          </Tip>
        )}
      </div>

      {deciders && glob.status !== 'signed_off' && <ScopeEditor glob={glob} attributes={attributes} busy={busy} onUpdate={onUpdate} />}

      {hasItem && <LearningFacts glob={glob} attributes={attributes} deciders={deciders} />}
      {hasItem && attributes.signal !== undefined && <SignalFigures signal={attributes.signal} />}
      {hasItem && learning !== null && <ProcessingState glob={glob} learning={learning} routed={target !== null} admin={admin} />}
      {hasItem && learning?.status === 'open' && <StaleNote glob={glob} attributes={attributes} admin={admin} />}
      {learning?.effectCheck != null && <EffectCheckView boardId={glob.boardId} check={learning.effectCheck} />}

      {outcome !== null && (
        <p className='text-sm' data-testid='decision-outcome'>
          <span className='font-medium'>{OUTCOME_TEXT[outcome.kind]}</span> by {outcome.by} on {when(outcome.at)}
          {outcome.reason !== undefined && <>: {outcome.reason}</>}
          {outcome.linkedGlobId !== undefined && (
            <>
              {' '}
              (waiting for{' '}
              <Link className='font-mono underline' to={`/boards/${String(glob.boardId)}?glob=${encodeURIComponent(outcome.linkedGlobId)}`}>
                {outcome.linkedGlobId}
              </Link>
              {outcome.workLanded === true && ', merged'})
            </>
          )}
        </p>
      )}

      {attributes.document !== undefined && diff.data?.draft != null ? (
        <DocumentProposal boardId={glob.boardId} document={attributes.document} content={diff.data.draft.content} />
      ) : (
        <ProposedChange globId={glob.id} />
      )}

      {canDecide && (
        <div className='grid gap-2' data-testid='outcomes'>
          <h3 className='text-xs font-semibold text-muted-foreground'>Decide</h3>
          <div className='flex flex-wrap gap-2'>
            {CHOICES.map(({ outcome: key, label: plain, tip: plainTip }) => {
              const label = key === 'accept' ? accept.label : plain;
              const tip = key === 'accept' ? accept.tip : plainTip;
              const unavailable = !hasItem && (key === 'accept_with_edits' || key === 'retarget');
              const kept = adminOnly !== null && (key === 'accept' || key === 'accept_with_edits');
              return (
                <Tip key={key} text={unavailable ? 'This decision has no knowledge item to edit or retarget' : kept ? `An admin decides it: it ${adminOnly}` : tip}>
                  <Button
                    size='sm'
                    variant={choice === key ? 'default' : key === 'reject' ? 'danger' : 'outline'}
                    disabled={busy || unavailable || kept}
                    aria-pressed={choice === key}
                    data-testid={`outcome-${key}`}
                    onClick={() => setChoice(choice === key ? null : key)}
                  >
                    {label}
                  </Button>
                </Tip>
              );
            })}
          </div>
          {admin && hasItem && learning?.status === 'open' && !isDocument && (
            <KeepAsLearning key={`${glob.id}-${String(glob.version)}`} glob={glob} attributes={attributes} learning={learning} busy={busy} />
          )}
          {choice !== null && (
            <OutcomeForm
              key={`${choice}-${applied?.outcome === choice ? 'applied' : 'plain'}`}
              choice={choice}
              prefill={applied?.outcome === choice ? applied : undefined}
              attributes={attributes}
              boardId={glob.boardId}
              busy={busy}
              draftText={diff.data?.draft?.content ?? ''}
              target={target}
              watchable={admin && canWatch(learning, attributes)}
              onCancel={() => setChoice(null)}
              onDecide={onDecide}
            />
          )}
        </div>
      )}
    </section>
  );
};
