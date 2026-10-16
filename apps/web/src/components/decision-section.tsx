import { channelLabel, channelSource, decisionOf, readSuggestion, SCOPE_KINDS, scopeLabel } from '@slop/core';
import type { ChannelSource, DecisionAttributes, DecisionLearning, DecisionScope, EditFailure, ScopeKind } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { HumanIcon, MachineIcon, MatrixIcon } from '@/components/actor-icons';
import { DiffView } from '@/components/diff-view';
import { DocumentProposal, EffectCheckView, inPipeline, PIPELINE_POLL_MS, ProcessingState, SignalFigures, StaleNote } from '@/components/decision-learning';
import { blocksReadOnly } from '@/lib/blocking-item';
import { isLearning, Outcomes, Recommendation } from '@/components/decision-outcomes';
import type { DecideFlow } from '@/components/decision-outcomes';
import { CollapsibleMarkdown, InlineMarkdown } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { BoardView, GlobChanges, GlobView } from '@/lib/api';
import { changeHeading, changeKindOf, OUTCOME_TEXT, SCOPE_EXPLAINED, scopeMatters } from '@/lib/decide-flow';
import { flagsOf } from '@/lib/assessment-flags';
import { SUGGESTION_ACTION_TEXT } from '@/lib/suggestion';
import { closedText, LINK_TEXT, linksByKind, targetText } from '@/lib/decision-links';
import { artifactKey, globDecisionsKey, globDiffKey } from '@/lib/live';
import { useToast } from '@/toast';
import { stripMarkdown } from '@/lib/markdown-text';
import { Tip } from './ui/tip';
import { boardGlobHref } from '@/lib/glob-section';

/** What the scope's reference means for each kind: null when the kind takes none. */
const REF_HINT: Record<ScopeKind, string | null> = {
  glob: 'Glob ID, e.g. s15t7',
  future_work: 'Only this group (blank: all new globs)',
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
          Applies to
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
                {SCOPE_EXPLAINED[k]}
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

/** The proposed change: headed by its target in words, then the diff of what approving it would do. */
const ProposedChange = ({ globId }: { globId: string }) => {
  const diff = useQuery({ queryKey: globDiffKey(globId), queryFn: () => api.globDiff(globId) });
  if (diff.isError) return <p className='text-sm text-red'>Could not load the proposed change.</p>;
  if (diff.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the proposed change…</p>;
  const { target, preview } = diff.data;
  const heading = changeHeading(target, preview === null ? 'edit' : changeKindOf(preview.diff, diff.data.sectionExisted));
  return (
    <div className='grid gap-1' data-testid='proposed-change'>
      {heading !== null && (
        <h3 className='text-xs font-semibold text-muted-foreground' data-testid='change-heading'>
          {heading}
        </h3>
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
          {preview.duplicateSections.length > 0 && (
            <span className='w-fit rounded bg-amber-500/15 px-1.5 text-xs text-amber-800 dark:text-amber-200' data-testid='duplicate-sections'>
              Target document has duplicate sections ({preview.duplicateSections.join(', ')}): the draft is of the last copy, and approving it is
              refused until the document is cleaned up
            </span>
          )}
          <DiffView lines={preview.diff} />
        </>
      )}
    </div>
  );
};

/** Why the change: the proposal text (the full statement, which the title only abbreviates), right above the change. */
const Why = ({ glob }: { glob: GlobView }) => {
  const plan = useQuery({ queryKey: ['plan', glob.id], queryFn: () => api.plan(glob.id) });
  const text = (plan.data?.current?.content ?? '').trim();
  return (
    <div className='grid gap-1' data-testid='why'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Why</h3>
      {plan.isPending ? null : text === '' ? (
        <p className='whitespace-pre-wrap break-words text-sm font-medium' data-testid='proposal-statement'>
          {stripMarkdown(glob.title)}
        </p>
      ) : (
        <CollapsibleMarkdown content={text} commands />
      )}
    </div>
  );
};

/** How often the learning was seen and on which globs: the evidence behind it, one line. */
const EvidenceSummary = ({ glob, attributes }: { glob: GlobView; attributes: DecisionAttributes }) => {
  const sources = attributes.sourceGlobs ?? [];
  const seen = attributes.evidenceCount ?? 0;
  if (seen === 0 && sources.length === 0) return null;
  return (
    <p className='text-xs text-muted-foreground' data-testid='evidence-summary'>
      {seen > 0 && `Seen ${String(seen)} time${seen === 1 ? '' : 's'}`}
      {sources.length > 0 && (
        <>
          {seen > 0 ? ' on ' : 'On '}
          {sources.length} glob{sources.length === 1 ? '' : 's'}:{' '}
          {sources.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link className='font-mono underline' to={boardGlobHref(glob.boardId, id)}>
                {id}
              </Link>
            </span>
          ))}
        </>
      )}
    </p>
  );
};

const SOURCE_ICON: Record<ChannelSource, typeof MachineIcon> = { agent: MachineIcon, person: HumanIcon, matrix: MatrixIcon };

/** Where the decision came from, one quiet line with its icon: from an agent, from a person, or the Matrix. */
const WhereFrom = ({ attributes }: { attributes: DecisionAttributes }) => {
  const Icon = SOURCE_ICON[channelSource(attributes.channel)];
  return (
    <p className='flex items-center gap-1.5 text-xs text-muted-foreground' data-testid='decision-source'>
      <span>Where it came from:</span>
      <Icon decorative />
      <span>{channelLabel(attributes.channel)}</span>
    </p>
  );
};

/** One quiet line under the buttons: what the decision applies to, with a "change" link that opens the explained options. */
const AppliesTo = ({
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
  const [editing, setEditing] = useState(false);
  return (
    <div className='grid gap-2 text-xs text-muted-foreground' data-testid='applies-to'>
      <p>
        <span data-testid='decision-scope'>Applies to: {scopeLabel(attributes.scope)}</span>{' '}
        <button type='button' className='underline' data-testid='change-scope' onClick={() => setEditing(!editing)}>
          {editing ? 'done' : 'change'}
        </button>
      </p>
      {editing && <ScopeEditor glob={glob} attributes={attributes} busy={busy} onUpdate={onUpdate} />}
    </div>
  );
};

/** Earlier recommendations, newest first, collapsed at the foot of the block; the latest is the block's recommendation. */
export const DecisionAssessment = ({ glob, all = false }: { glob: GlobView; all?: boolean }) => {
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment' && a.label === '');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', ''),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', ''),
    enabled: has,
  });
  const older = [...(versions.data ?? [])].slice(0, all ? undefined : -1).reverse();
  if (older.length === 0) return null;
  return (
    <details className='grid gap-2' data-testid='assessment-history'>
      <summary className='cursor-pointer text-xs font-semibold text-muted-foreground'>Earlier recommendations ({older.length})</summary>
      <div className='mt-2 grid gap-2'>
        {older.map((v) => (
          <div key={v.version} className='rounded border p-3'>
            <CollapsibleMarkdown content={v.content} commands />
          </div>
        ))}
      </div>
    </details>
  );
};

/** The flags the rules raised, from the latest rule-based assessment (it also lists scope, target and the like, which the view shows elsewhere). */
const AssessmentFlags = ({ glob }: { glob: GlobView }) => {
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment' && a.label === '');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', ''),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', ''),
    enabled: has,
  });
  const flags = flagsOf(versions.data?.at(-1)?.content ?? '');
  if (flags.length === 0) return null;
  return (
    <div className='grid gap-1 text-xs' data-testid='assessment-flags'>
      <h4 className='font-semibold text-muted-foreground'>Flags</h4>
      <ul className='list-disc pl-4'>
        {flags.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </div>
  );
};

/** The recommendations before the latest one, newest first. */
const EarlierRecommendations = ({ glob }: { glob: GlobView }) => {
  const has = (glob.artifacts ?? []).some((a) => a.kind === 'assessment' && a.label === 'suggestion');
  const versions = useQuery({
    queryKey: artifactKey(glob.id, 'assessment', 'suggestion'),
    queryFn: () => api.artifactVersions(glob.id, 'assessment', 'suggestion'),
    enabled: has,
  });
  const older = [...(versions.data ?? [])].slice(0, -1).reverse();
  if (older.length === 0) return null;
  return (
    <div className='grid gap-1 text-xs' data-testid='assessment-history'>
      <h4 className='font-semibold text-muted-foreground'>Earlier recommendations ({older.length})</h4>
      <ul className='grid gap-1'>
        {older.map((v) => {
          const stored = readSuggestion(v.content);
          return (
            <li key={v.version} className='whitespace-pre-wrap break-words'>
              {stored === null ? (
                v.content
              ) : (
                <>
                  <span className='font-medium'>{SUGGESTION_ACTION_TEXT[stored.suggestion.action]}.</span> <InlineMarkdown text={stored.suggestion.reason} />{' '}
                  <span className='text-muted-foreground'>({when(stored.at)})</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** A learning's Evidence and history, collapsed: the evidence behind it, what it is aimed at, the flags raised and the recommendations before the latest. */
const EvidenceAndHistory = ({ glob, attributes, deciders }: { glob: GlobView; attributes: DecisionAttributes; deciders: boolean }) => (
  <details className='grid gap-2' data-testid='evidence-history'>
    <summary className='cursor-pointer text-xs font-semibold text-muted-foreground'>Evidence and history</summary>
    <div className='mt-2 grid gap-3'>
      <EvidenceSummary glob={glob} attributes={attributes} />
      {attributes.signal !== undefined && <SignalFigures signal={attributes.signal} />}
      <LearningFacts glob={glob} attributes={attributes} deciders={deciders} />
      <AssessmentFlags glob={glob} />
      <EarlierRecommendations glob={glob} />
    </div>
  </details>
);

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
    <section className='grid gap-3' data-testid='decision-section'>
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
          <span className='font-medium'>Why slop thinks so:</span> <InlineMarkdown text={newer.reason} />
        </p>
      )}
      {outcome !== null && (
        <p className='text-sm' data-testid='decision-outcome'>
          <span className='font-medium'>{outcome.kind === 'accept' ? 'Confirmed' : outcome.kind === 'reject' ? 'Dismissed' : 'Closed: no longer relevant'}</span>
          {outcome.kind !== 'closed' && <> by {outcome.by}</>} on {when(outcome.at)}
          {outcome.reason !== undefined && outcome.kind !== 'closed' && <>: <InlineMarkdown text={outcome.reason} /></>}
        </p>
      )}
      {open && deciders && !blocksReadOnly(glob) && (
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
  const open = (id: string) => boardGlobHref(glob.boardId, id, { section: 'decision' });
  return (
    <div className='grid gap-1 text-xs' data-testid='learning-facts'>
      <p className='text-muted-foreground'>
        {attributes.kind ?? 'learning'}
        {target === null ? '' : ` → ${target}`}
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
    </div>
  );
};

/**
 * What a decision glob shows in place of a work glob's branch, PR and runs: one proposal block that reads top to bottom as
 * the statement (with its facts and signal), what approving it changes (the target and its diff or document), and the
 * outcome controls, ending with the outcome so far when there is one.
 */
export const DecisionSection = ({
  board,
  glob,
  busy,
  decide,
  onUpdate,
}: {
  board: BoardView;
  glob: GlobView;
  busy: boolean;
  /** The decide flow the header's Approve change shares; without one the block has no outcome controls. */
  decide: DecideFlow | null;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
}) => {
  const attributes = decisionOf(glob);
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
  const hotspotPath = attributes.origin.kind === 'hotspot' ? attributes.origin.path : null;
  const canDecide = (glob.allowedActions ?? []).includes('decide');
  const conflicts = attributes.conflictsWith ?? [];
  const outcome = attributes.outcome;
  const hasItem = isLearning(attributes);
  const open = (canDecide || deciders) && glob.status !== 'signed_off';
  const showScope = open && deciders && diff.data !== undefined && scopeMatters(attributes.document !== undefined, hotspotPath !== null, target);
  return (
    <section className='grid gap-3' data-testid='decision-section'>
      {outcome !== null && (
        <p className='text-sm' data-testid='decision-outcome'>
          <span className='font-medium'>{OUTCOME_TEXT[outcome.kind]}</span> by {outcome.by} on {when(outcome.at)}
          {outcome.reason !== undefined && <>: <InlineMarkdown text={outcome.reason} /></>}
          {outcome.linkedGlobId !== undefined && (
            <>
              {' '}
              ({attributes.origin.kind === 'hotspot' ? 'refactor glob' : 'waiting for'}{' '}
              <Link className='font-mono underline' to={`/boards/${String(glob.boardId)}?glob=${encodeURIComponent(outcome.linkedGlobId)}`}>
                {outcome.linkedGlobId}
              </Link>
              {outcome.workLanded === true && ', merged'})
            </>
          )}
        </p>
      )}
      <div className='grid gap-3' data-testid='proposal-block'>
        {(hotspotPath !== null || conflicts.length > 0) && (
          <div className='flex flex-wrap items-center gap-2 text-xs'>
            {hotspotPath !== null && (
              <span className='rounded bg-muted px-2 py-0.5' data-testid='decision-scope'>
                Conflict hotspot: <span className='font-mono'>{hotspotPath}</span>
              </span>
            )}
            {conflicts.length > 0 && (
              <Tip text='This decision contradicts a decision with a broader scope, which wins where they disagree'>
                <span className='rounded bg-amber-500/15 px-1.5 text-amber-800 dark:text-amber-200' data-testid='conflicts-chip'>
                  Conflicts with{' '}
                  {conflicts.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <Link className='font-mono underline' to={boardGlobHref(glob.boardId, id, { section: 'decision' })}>
                        {id}
                      </Link>
                    </span>
                  ))}{' '}
                  (broader scope)
                </span>
              </Tip>
            )}
          </div>
        )}

        {hasItem && learning !== null && <ProcessingState glob={glob} learning={learning} routed={target !== null} admin={admin} />}
        {hasItem && learning?.status === 'open' && <StaleNote glob={glob} attributes={attributes} admin={admin} />}
        {learning?.effectCheck != null && <EffectCheckView boardId={glob.boardId} check={learning.effectCheck} />}
        {!hasItem && attributes.signal !== undefined && <SignalFigures signal={attributes.signal} />}

        {hasItem && <Why glob={glob} />}
        {!hasItem && (
          <p className='whitespace-pre-wrap break-words text-sm font-medium' data-testid='proposal-statement'>
            {stripMarkdown(glob.title)}
          </p>
        )}

        {attributes.document !== undefined && diff.data?.draft != null ? (
          <DocumentProposal boardId={glob.boardId} document={attributes.document} content={diff.data.draft.content} />
        ) : (
          <ProposedChange globId={glob.id} />
        )}

        {open && decide !== null && decide.canSuggest && <Recommendation glob={glob} suggest={decide.suggest} />}
        {/* The outcomes live in this block, not in the action row. Not in Planning: Pick up / Start is the only action there. */}
        {open && !blocksReadOnly(glob) && (!hasItem || learning === null || learning.status === 'open') && decide !== null && (canDecide || deciders) && <Outcomes flow={decide} />}
        {showScope && <AppliesTo glob={glob} attributes={attributes} busy={busy} onUpdate={onUpdate} />}
        <WhereFrom attributes={attributes} />
        {hasItem && <EvidenceAndHistory glob={glob} attributes={attributes} deciders={deciders} />}
      </div>
    </section>
  );
};
