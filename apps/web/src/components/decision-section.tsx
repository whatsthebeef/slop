import { decisionOf, KNOWLEDGE_KINDS, SCOPE_KINDS, scopeLabel } from '@slop/core';
import type { DecisionAttributes, DecisionOutcomeKind, DecisionScope, EditFailure, KnowledgeKind, ScopeKind } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DiffView } from '@/components/diff-view';
import { MarkdownView } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { artifactKey, globDiffKey } from '@/lib/live';
import { Tip } from './ui/tip';

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
  busy,
  draftText,
  onCancel,
  onDecide,
}: {
  choice: Choice;
  attributes: DecisionAttributes;
  busy: boolean;
  draftText: string;
  onCancel: () => void;
  onDecide: (input: DecideInput) => Promise<boolean>;
}) => {
  const [reason, setReason] = useState('');
  const [edited, setEdited] = useState(draftText);
  const [linked, setLinked] = useState('');
  const [kind, setKind] = useState<KnowledgeKind>('doc');
  const [name, setName] = useState('');
  const [section, setSection] = useState('');
  // The draft arrives after the form opens when the pipeline is still working; fill it in until the person types.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setEdited(draftText);
  }, [draftText, touched]);
  const send = (input: DecideInput) => void onDecide(input).then((done) => done && onCancel());
  const trimmed = reason.trim();
  const inputFor = (): DecideInput => {
    switch (choice) {
      case 'accept_with_edits':
        return { outcome: choice, editedDraft: edited };
      case 'retarget':
        return { outcome: choice, target: { kind, name: name.trim(), section: section.trim() === '' ? null : section.trim() } };
      case 'needs_work':
        return { outcome: choice, ...(linked.trim() === '' ? {} : { linkedGlobId: linked.trim() }), ...(trimmed === '' ? {} : { reason: trimmed }) };
      case 'reject':
        return { outcome: choice, reason: trimmed };
      case 'accept':
        return { outcome: choice };
    }
  };
  return (
    <div className='grid gap-2 rounded border p-3' data-testid={`outcome-form-${choice}`}>
      {choice === 'accept' && (
        <p className='text-xs text-muted-foreground'>
          {attributes.kbItemId === null
            ? 'Records the decision as accepted; there is no knowledge change to apply.'
            : 'Applies the proposed change to its target, then moves this decision to Reviewing.'}
        </p>
      )}
      {choice === 'accept_with_edits' && (
        <Label>
          Edited text (a section's new text, or a new document's body)
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

/** The assessment slop wrote about the proposal (what it changes, flags, a suggested outcome), beside the review section. */
export const DecisionAssessment = ({ glob }: { glob: GlobView }) => {
  const client = useQueryClient();
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', ''),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', ''),
    enabled: has,
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = versions.data?.at(-1);
  return (
    <div className='grid gap-2' data-testid='assessment'>
      <div className='flex items-center gap-2'>
        <h3 className='text-xs font-semibold text-muted-foreground'>Assessment</h3>
        <Button
          size='sm'
          variant='outline'
          disabled={busy}
          data-testid='assess'
          onClick={() => {
            setBusy(true);
            setFailed(false);
            api
              .assess(glob.id)
              .then(() => client.invalidateQueries({ queryKey: artifactKey(glob.id, 'assessment', '') }))
              .then(() => client.invalidateQueries({ queryKey: ['globs', glob.boardId] }))
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        >
          {has ? 'Reassess' : 'Assess'}
        </Button>
        {failed && <span className='text-xs text-red'>Could not assess it.</span>}
      </div>
      {latest === undefined ? (
        <p className='text-sm text-muted-foreground'>{has ? 'Loading…' : 'Not assessed yet.'}</p>
      ) : (
        <div className='rounded border p-3'>
          <MarkdownView content={latest.content} />
        </div>
      )}
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
}: {
  board: BoardView;
  glob: GlobView;
  busy: boolean;
  onDecide: (input: DecideInput) => Promise<boolean>;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
}) => {
  const attributes = decisionOf(glob);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => setChoice(null), [glob.id, glob.version]);
  const diff = useQuery({ queryKey: globDiffKey(glob.id), queryFn: () => api.globDiff(glob.id) });
  if (attributes === null) return null;
  const deciders = board.role === 'admin' || board.role === 'po';
  const canDecide = (glob.allowedActions ?? []).includes('decide');
  const conflicts = attributes.conflictsWith ?? [];
  const outcome = attributes.outcome;
  const hasItem = attributes.kbItemId !== null;
  return (
    <section className='grid gap-3 rounded border border-edge p-3' data-testid='decision-section'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <span className='rounded bg-muted px-2 py-0.5' data-testid='decision-scope'>
          Applies to {scopeLabel(attributes.scope)}
        </span>
        <span className='text-muted-foreground'>via {attributes.channel}</span>
        {attributes.kbItemId !== null && (
          <Link className='font-mono underline-offset-2 hover:underline' to={`/boards/${String(glob.boardId)}/knowledge`}>
            {attributes.kbItemId}
          </Link>
        )}
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

      <ProposedChange globId={glob.id} />

      {canDecide && (
        <div className='grid gap-2' data-testid='outcomes'>
          <h3 className='text-xs font-semibold text-muted-foreground'>Decide</h3>
          <div className='flex flex-wrap gap-2'>
            {CHOICES.map(({ outcome: key, label, tip }) => {
              const unavailable = !hasItem && (key === 'accept_with_edits' || key === 'retarget');
              return (
                <Tip key={key} text={unavailable ? 'This decision has no knowledge item to edit or retarget' : tip}>
                  <Button
                    size='sm'
                    variant={choice === key ? 'default' : key === 'reject' ? 'danger' : 'outline'}
                    disabled={busy || unavailable}
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
          {choice !== null && (
            <OutcomeForm
              key={choice}
              choice={choice}
              attributes={attributes}
              busy={busy}
              draftText={diff.data?.draft?.content ?? ''}
              onCancel={() => setChoice(null)}
              onDecide={onDecide}
            />
          )}
        </div>
      )}
    </section>
  );
};
