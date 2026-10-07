import { agentSetKind, KB_HISTORY_MAX, KB_HISTORY_PAGE, llmWaitingReason, MAX_PROCESSING_ATTEMPTS, PROSE_KINDS, sameHeading, sectionText, spliceHeadings } from '@slop/core';
import type {
  AgentSetEntry,
  Approval,
  ContextDiffLine,
  DraftPreview,
  KbItem,
  KbItemView,
  KbTarget,
  KnowledgeKind,
  ProposedDocument,
  TargetChange,
} from '@slop/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { MarkdownView } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useCardMotion } from '@/lib/card-motion';
import type { CardMotionOptions } from '@/lib/card-motion';
import { invalidateKnowledge } from '@/lib/live';
import type { LiveState } from '@/lib/live';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';

type Decision = 'learning' | 'document' | 'reject';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

/** Agent-set paths the board owns outright: their target is the whole file, not board rules over the catalog's. */
const ownedPaths = (entries: readonly AgentSetEntry[]) =>
  new Set(entries.filter((e) => e.status === 'board_file' || e.status === 'override').map((e) => e.path));

/** A target as a readable path: `build_test_lint › Build`, `agents/implementer.md › Board rules`, or a new document. */
const targetPath = (target: KbTarget, owned: ReadonlySet<string>): string => {
  if (target.newDocument !== null) {
    const { area, audience } = target.newDocument;
    return `new document: ${target.name} (${area}${audience.length === 0 ? '' : `, for ${audience.join(', ')}`})`;
  }
  const parts = [target.name, ...(target.kind !== 'doc' && !owned.has(target.name) ? ['Board rules'] : [])];
  return [...parts, ...(target.section === null ? [] : [target.section])].join(' › ');
};

/** Items the pipeline closed without a decision: they leave the open queue but keep their links. */
const CLOSED_BY_PIPELINE: readonly KbItem['status'][] = ['merged', 'suppressed', 'covered'];

/** The fallback poll while the pipeline is working; hints normally refresh the list (as the board's deploy poll). */
const PIPELINE_POLL_MS = 15_000;

/** Whether the background pipeline still has work to do on an item (routing, or its draft). */
const inPipeline = (item: KbItem) => item.status === 'open' && (item.processing === 'pending' || item.processing === 'routed');

/** The newest evidence an item has: its own submission or a near-duplicate merged into it. */
const lastEvidenceAt = (item: KbItem) => item.extraEvidence.reduce((latest, e) => (e.at > latest ? e.at : latest), item.createdAt);

/**
 * Open items: the most repeated first (repeats are the strongest sign a rule is missing), then the
 * freshest evidence, so an item that keeps coming back rises instead of sinking under new ones.
 */
const byPriority = (a: KbItem, b: KbItem) =>
  b.occurrenceCount - a.occurrenceCount || lastEvidenceAt(b).localeCompare(lastEvidenceAt(a));

/**
 * Card motion as on the board (`useCardMotion`): an item that moves between the open list and the
 * decided or closed sections steps across, and the cards it displaces (or a reordering by
 * repeats and evidence) glide. No tags: the card's own outcome says what happened.
 */
const KB_MOTION: CardMotionOptions<KbItem> = {
  attribute: 'data-kb-id',
  idOf: (item) => item.id,
  groupOf: (item) =>
    item.status === 'open' ? 'open' : item.status === 'approved' || item.status === 'rejected' ? 'decided' : 'closed',
  describeRemote: () => null,
};

/** The cards' lock flashes, and how a decision made here marks its move as yours. */
const KbMotion = createContext<{ locks: Record<string, 'local' | 'remote'>; markLocal: (id: string) => void }>({
  locks: {},
  markLocal: () => undefined,
});

/** Scrolls to another item's card, opening the collapsed section it sits in. */
const jumpTo = (id: string) => {
  const card = document.getElementById(`kb-${id}`);
  if (card === null) return;
  const section = card.closest('details');
  if (section !== null) section.open = true;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const ItemLink = ({ id }: { id: string }) => (
  <button type='button' className='font-mono underline decoration-dotted hover:decoration-solid' onClick={() => jumpTo(id)}>
    {id}
  </button>
);

/** Context shared by every card: the board, its documents, how its agent files are served, and the document viewer. */
interface Board {
  readonly boardId: number;
  readonly admin: boolean;
  readonly documents: readonly BoardDocument[];
  readonly owned: ReadonlySet<string>;
  readonly onOpenDocument: (name: string) => void;
}

/** A link to a glob on the board (its view opens there, or on the signed-off page). */
const GlobLinks = ({ boardId, ids }: { boardId: number; ids: readonly string[] }) =>
  ids.map((id, index) => (
    <span key={id}>
      {index > 0 && ', '}
      <Link
        className='font-mono underline decoration-dotted hover:decoration-solid'
        to={`/boards/${boardId}?glob=${encodeURIComponent(id)}`}
      >
        {id}
      </Link>
    </span>
  ));

/** A document or agent-file name: documents open in the viewer, agent files are plain text. */
const KnowledgeRef = ({ board, name, rest }: { board: Board; name: string; rest?: string }) =>
  board.documents.some((d) => d.name === name) ? (
    <>
      <button type='button' className='underline decoration-dotted hover:decoration-solid' onClick={() => board.onOpenDocument(name)}>
        {name}
      </button>
      {rest}
    </>
  ) : (
    <>
      {name}
      {rest}
    </>
  );

const outcomeText = (item: KbItem, board: Board): ReactNode => {
  if (item.status === 'merged') {
    return (
      <>
        Merged into <ItemLink id={item.duplicateOf ?? '?'} /> (a near-duplicate)
      </>
    );
  }
  if (item.status === 'suppressed') {
    return (
      <>
        Suppressed: matches rejected <ItemLink id={item.suppressedBy ?? '?'} />
      </>
    );
  }
  if (item.status === 'covered') {
    const by = item.coveredBy;
    if (by === null) return 'Already covered';
    return by.kind === 'item' ? (
      <>
        Already covered by approved <ItemLink id={by.id} />
      </>
    ) : (
      <>
        Already covered by <KnowledgeRef board={board} name={by.name} rest={by.section === null ? '' : ` › ${by.section}`} />
      </>
    );
  }
  if (item.status === 'rejected') return `Rejected: ${item.decisionReason ?? ''}`;
  if (item.outcome?.kind === 'applied') {
    return (
      <>
        Applied to <KnowledgeRef board={board} name={item.outcome.name} rest={` v${item.outcome.version}`} />
      </>
    );
  }
  return 'Kept as a learning';
};

/** A board document as the Knowledge page's index lists it. */
export interface BoardDocument {
  readonly name: string;
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
  readonly version: number;
}

const sameAudience = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

const audienceText = (audience: readonly string[]) => (audience.length === 0 ? 'no agents' : audience.join(', '));

/** After a refused write: a version conflict carries the item as it is now, so the list is refetched to show it. */
const reportError = (client: QueryClient, boardId: number, toast: (text: string) => void, error: unknown) => {
  if (error instanceof RequestError && error.body.code === 'version_conflict') {
    toast(`${error.body.message}. The list now shows it as it is.`);
    void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
    return;
  }
  toast(message(error));
};

const appliedText = (decided: KbItem) =>
  decided.outcome?.kind === 'applied'
    ? `${decided.id} applied to ${decided.outcome.name} v${decided.outcome.version}`
    : `${decided.id} approved`;

/** Everything a decision or edit can change: the items, the documents and the agent set. */
const refresh = (client: QueryClient, boardId: number) => invalidateKnowledge(client, boardId);

/**
 * A document proposal against the board: new, or replacing an existing document, in which case the
 * current version is shown beside the proposed one and changed metadata is called out. Audience
 * changes matter most: they decide which agents are always given the document.
 */
const DocumentComparison = ({
  boardId,
  proposed,
  existing,
  proposedContent,
}: {
  boardId: number;
  proposed: ProposedDocument;
  existing: BoardDocument | null;
  proposedContent: ReactNode;
}) => {
  const current = useQuery({
    queryKey: ['kb-doc', boardId, existing?.name ?? null],
    queryFn: () => api.knowledgeDoc(boardId, existing?.name ?? ''),
    enabled: existing !== null,
  });
  if (existing === null) {
    return (
      <div className='grid gap-1 text-xs'>
        <span>
          New document <span className='font-medium'>{proposed.name}</span> · area {proposed.area} · always for:{' '}
          {audienceText(proposed.audience)}
        </span>
        <span className='text-muted-foreground'>{proposed.description}</span>
        {proposedContent}
      </div>
    );
  }
  const currentContent = current.data?.find((d) => d.name === existing.name)?.content;
  return (
    <div className='grid gap-2 text-xs'>
      <p className='font-medium'>
        Replaces {existing.name} (v{existing.version})
      </p>
      {!sameAudience(existing.audience, proposed.audience) && (
        <p className='rounded-md border border-required-border bg-red-soft/15 p-2' data-testid='audience-change'>
          Audience changes from <span className='font-medium'>{audienceText(existing.audience)}</span> to{' '}
          <span className='font-medium'>{audienceText(proposed.audience)}</span>: this changes which agents are always given
          the document.
        </p>
      )}
      <div className='grid gap-3 md:grid-cols-2'>
        <div className='grid content-start gap-1'>
          <span className='font-semibold'>Current (v{existing.version})</span>
          <span className={existing.area === proposed.area ? 'text-muted-foreground' : 'font-medium'}>
            area {existing.area ?? '—'}
          </span>
          <span className='text-muted-foreground'>always for: {audienceText(existing.audience)}</span>
          <span className={existing.description === proposed.description ? 'text-muted-foreground' : 'font-medium'}>
            {existing.description || '—'}
          </span>
          <MarkdownView content={currentContent ?? 'Loading…'} />
        </div>
        <div className='grid content-start gap-1'>
          <span className='font-semibold'>Proposed</span>
          <span className={existing.area === proposed.area ? 'text-muted-foreground' : 'font-medium'}>area {proposed.area}</span>
          <span className='text-muted-foreground'>always for: {audienceText(proposed.audience)}</span>
          <span className={existing.description === proposed.description ? 'text-muted-foreground' : 'font-medium'}>
            {proposed.description}
          </span>
          {proposedContent}
        </div>
      </div>
    </div>
  );
};

/**
 * Where the background pipeline is with an open item: routing or drafting (with the last error and
 * the next try while retrying), waiting for the AI to be usable again (no Retry: it resumes by
 * itself once the sign-in or access is fixed), or given up on, with Retry for admins.
 */
const ProcessingState = ({ item, admin, onRetry, retrying }: { item: KbItem; admin: boolean; onRetry: () => void; retrying: boolean }) => {
  if (item.status !== 'open') return null;
  const stage = item.target === null ? 'Routing' : 'Drafting';
  if (item.processing === 'failed') {
    return (
      <div
        className='flex flex-wrap items-center gap-2 rounded-md border border-required-border bg-red-soft/15 p-2 text-xs'
        data-testid='processing-failed'
      >
        <span>
          {stage} failed: {item.processingError ?? 'unknown error'}
        </span>
        {admin && (
          <Button size='sm' variant='outline' className='ml-auto' disabled={retrying} onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (!inPipeline(item)) return null;
  const waiting = llmWaitingReason(item);
  if (waiting !== null) {
    return (
      <p className='text-xs text-muted-foreground' data-testid='processing-waiting'>
        Waiting: AI unavailable — {waiting}. {item.target === null ? 'Routing' : 'Drafting'} resumes once it works again.
      </p>
    );
  }
  const working = item.processing === 'pending' ? 'Routing…' : 'Drafting…';
  // While retrying, `processAfter` is the backoff's end (or, once picked up again, the lease's).
  const next = item.processAfter === null ? 'shortly' : `by ${new Date(item.processAfter).toLocaleTimeString()}`;
  return (
    <p className='text-xs text-muted-foreground' data-testid='processing'>
      {working}
      {item.processingError !== null &&
        ` Attempt ${item.processingAttempts} of ${MAX_PROCESSING_ATTEMPTS} failed: ${item.processingError}. Trying again ${next}.`}
    </p>
  );
};

/** Diffs longer than this start collapsed. */
const LONG_DIFF = 40;

const DiffLines = ({ lines }: { lines: readonly ContextDiffLine[] }) =>
  lines.map((line, index) =>
    line.op === 'skipped' ? (
      <div key={index} className='text-muted-foreground'>
        … {line.count} unchanged line{line.count === 1 ? '' : 's'}
      </div>
    ) : (
      <div
        key={index}
        className={
          line.op === 'removed'
            ? 'bg-red-500/10 text-red-700 dark:text-red-300'
            : line.op === 'added'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'text-muted-foreground'
        }
      >
        {line.op === 'added' ? '+ ' : line.op === 'removed' ? '- ' : '  '}
        {line.text}
      </div>
    ),
  );

/** A drafted change: its rationale and the diff approving it would make to the target as it is now. */
const DraftView = ({ rationale, preview }: { rationale: string | null; preview: DraftPreview }) => {
  const [expanded, setExpanded] = useState(false);
  const long = preview.diff.length > LONG_DIFF;
  return (
    <div className='grid gap-1 text-xs' data-testid='draft'>
      {rationale !== null && (
        <span>
          <span className='font-medium'>Why: </span>
          {rationale}
        </span>
      )}
      {preview.stale && (
        <span className='w-fit rounded bg-amber-500/15 px-1.5 text-amber-800 dark:text-amber-200'>
          Stale draft: the target changed since it was drafted; it is being drafted again
        </span>
      )}
      <pre className='max-h-[32rem] overflow-auto rounded-md border text-xs' data-testid='draft-diff'>
        <DiffLines lines={long && !expanded ? preview.diff.slice(0, LONG_DIFF) : preview.diff} />
      </pre>
      {long && (
        <button type='button' className='w-fit text-muted-foreground hover:underline' onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all ${preview.diff.length} lines`}
        </button>
      )}
    </div>
  );
};

/** The original evidence and what near-duplicates added, each with links to the globs it came from. */
const Evidence = ({ boardId, item }: { boardId: number; item: KbItem }) => (
  <div className='grid gap-1 text-xs' data-testid='evidence'>
    <span className='font-medium'>
      Evidence{item.occurrenceCount > 1 && <span className='ml-1 rounded bg-muted px-1.5 font-normal'>seen {item.occurrenceCount}×</span>}
    </span>
    <ul className='ml-4 list-disc'>
      <li className='whitespace-pre-wrap'>
        <span className='text-muted-foreground'>
          {item.sourceGlobIds.length > 0 ? <GlobLinks boardId={boardId} ids={item.sourceGlobIds} /> : 'no source glob'} ·{' '}
          {item.submittedBy} · {when(item.createdAt)}:{' '}
        </span>
        {item.evidence}
      </li>
      {item.extraEvidence.map((e) => (
        <li key={e.itemId} className='whitespace-pre-wrap'>
          <span className='text-muted-foreground'>
            <ItemLink id={e.itemId} />
            {e.globIds.length > 0 && (
              <>
                {' '}
                (<GlobLinks boardId={boardId} ids={e.globIds} />)
              </>
            )}{' '}
            · {e.submittedBy} · {when(e.at)}:{' '}
          </span>
          {e.evidence}
        </li>
      ))}
    </ul>
  </div>
);

/** What the pipeline flagged: a suggested catalog change, and contradictions with other items or knowledge. */
const Flags = ({ item, board }: { item: KbItem; board: Board }) => (
  <>
    {item.catalogCandidate && (
      <p className='text-xs'>
        <span className='mr-1 rounded bg-muted px-1.5 font-medium'>catalog candidate</span>
        <span className='text-muted-foreground'>
          Would hold for any project, so it may belong in slop's catalog{item.catalogReason === null ? '' : `: ${item.catalogReason}`}
        </span>
      </p>
    )}
    {item.possiblyCoveredBy !== null && (
      <p className='rounded-md border border-border bg-muted/40 p-2 text-xs' data-testid='possibly-covered'>
        <span className='font-medium'>May already be covered by </span>
        <KnowledgeRef
          board={board}
          name={item.possiblyCoveredBy.name}
          rest={item.possiblyCoveredBy.section === null ? '' : ` › ${item.possiblyCoveredBy.section}`}
        />
        <span className='font-medium'>: </span>
        <span className='text-muted-foreground'>
          “{item.possiblyCoveredBy.quote}”{item.possiblyCoveredBy.reason !== '' && ` (${item.possiblyCoveredBy.reason})`}. Approve, reject as already
          covered, or keep it.
        </span>
      </p>
    )}
    {item.contradicts.length > 0 && (
      <div className='rounded-md border border-required-border bg-red-soft/15 p-2 text-xs' data-testid='contradictions'>
        <span className='font-medium'>Contradicts:</span>
        <ul className='ml-4 list-disc'>
          {item.contradicts.map((c) => {
            const [name = c.ref, ...section] = c.ref.split(' § ');
            return (
              <li key={`${c.kind}:${c.ref}`}>
                {c.kind === 'item' ? (
                  <ItemLink id={c.ref} />
                ) : (
                  <KnowledgeRef board={board} name={name} rest={section.length === 0 ? '' : ` › ${section.join(' § ')}`} />
                )}
                {c.note !== '' && ` — ${c.note}`}
              </li>
            );
          })}
        </ul>
      </div>
    )}
  </>
);

/** Why Approve is unavailable for an open statement item, or null when it can be approved. */
const approveBlocker = (item: KbItemView): string | null => {
  const failed = item.processing === 'failed';
  if (item.target === null) return failed ? 'No target: choose one under Edit, or retry' : 'Approve once it is routed and drafted';
  if (item.preview?.stale === true) return 'The draft is stale; approve once it is drafted again';
  if (item.draft === null) return failed ? 'No draft: write one under Edit, or retry' : 'Approve once the draft is ready';
  if (item.preview === null) return `${item.target.name} is no longer on the board; change the target under Edit`;
  return null;
};

type Opening = { kind: 'decision'; decision: Decision } | { kind: 'edit' };

const ProposalCard = ({
  board,
  item,
  existing,
  onOpen,
}: {
  board: Board;
  item: KbItemView;
  /** For an open document proposal: the board document of the same name, if there is one. */
  existing: BoardDocument | null;
  onOpen: (opening: Opening) => void;
}) => {
  const { boardId, admin } = board;
  const { locks, markLocal } = useContext(KbMotion);
  const lock = locks[item.id];
  const [showDocument, setShowDocument] = useState(false);
  const open = item.status === 'open';
  const client = useQueryClient();
  const toast = useToast();
  const preview = open && item.draft !== null ? item.preview : null;
  const approveDraft = useMutation({
    mutationFn: () => api.approveProposal(item.id, item.version, { as: 'draft' }),
    onSuccess: (decided) => {
      markLocal(decided.id);
      toast(appliedText(decided));
      refresh(client, boardId);
    },
    // A stale draft is refused and drafted again; the refetch shows that.
    onError: (e) => reportError(client, boardId, toast, e),
  });
  const retry = useMutation({
    mutationFn: () => api.retryProposal(item.id, item.version),
    onSuccess: (retried) => {
      toast(`${retried.id} is being ${retried.processing === 'pending' ? 'routed' : 'drafted'} again`);
      void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
    },
    onError: (e) => reportError(client, boardId, toast, e),
  });
  const reopen = useMutation({
    mutationFn: () => api.reopenProposal(item.id, item.version),
    onSuccess: (reopened) => {
      markLocal(reopened.id);
      toast(`${reopened.id} is open again`);
      void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
    },
    onError: (e) => reportError(client, boardId, toast, e),
  });
  const closedByPipeline = CLOSED_BY_PIPELINE.includes(item.status);
  const blocker = open && item.document === null ? approveBlocker(item) : null;

  return (
    <div
      id={`kb-${item.id}`}
      className={cn('grid gap-2 rounded-md border bg-card p-3 text-sm', lock === 'local' && 'lock-local', lock === 'remote' && 'lock-remote')}
      data-kb-id={item.id}
      data-testid={`proposal-${item.id}`}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <span className='font-mono text-xs font-semibold'>{item.id}</span>
        <span className='rounded bg-muted px-1.5 text-xs'>{item.type}</span>
        {item.document !== null && (
          <span className='rounded bg-muted px-1.5 text-xs'>
            {existing === null ? 'new document' : `replaces ${existing.name} (v${existing.version})`}
          </span>
        )}
        <span className='ml-auto text-xs text-muted-foreground'>
          {item.submittedBy} · {when(item.createdAt)}
          {item.agentSetVersion !== null && ` · agent set v${item.agentSetVersion}`}
        </span>
      </div>
      <p className='font-medium'>{item.statement}</p>
      {item.target !== null && item.document === null && (
        <p className='text-xs' data-testid='target'>
          <span className='font-medium'>Target: </span>
          <span className='font-mono'>{targetPath(item.target, board.owned)}</span>
        </p>
      )}
      {item.suggestedTarget !== null && open && (
        <p className='text-xs text-muted-foreground'>Suggested by the submitter: {item.suggestedTarget}</p>
      )}
      <ProcessingState item={item} admin={admin} onRetry={() => retry.mutate()} retrying={retry.isPending} />
      {preview !== null && <DraftView rationale={item.rationale} preview={preview} />}
      <Evidence boardId={boardId} item={item} />
      {open && <Flags item={item} board={board} />}
      {item.document !== null && (
        <div className='grid gap-1 text-xs'>
          <span>
            <span className='font-medium'>{item.document.name}</span> · area {item.document.area} · always for:{' '}
            {audienceText(item.document.audience)}
          </span>
          <span className='text-muted-foreground'>{item.document.description}</span>
          {existing !== null && !sameAudience(existing.audience, item.document.audience) && (
            <span className='font-medium'>
              Changes the audience of {existing.name} from {audienceText(existing.audience)}
            </span>
          )}
          <button type='button' className='w-fit text-left hover:underline' onClick={() => setShowDocument(!showDocument)}>
            {showDocument ? 'Hide document' : existing === null ? 'Show document' : 'Compare with the current document'}
          </button>
          {showDocument && (
            <DocumentComparison
              boardId={boardId}
              proposed={item.document}
              existing={existing}
              proposedContent={<MarkdownView content={item.document.content} />}
            />
          )}
        </div>
      )}
      {!open && (
        <p className='text-xs'>
          {outcomeText(item, board)}{' '}
          {item.decidedBy !== null && (
            <span className='text-muted-foreground'>
              · {item.decidedBy} · {when(item.decidedAt)}
            </span>
          )}
        </p>
      )}
      {closedByPipeline && admin && (
        <div className='mt-1 flex flex-wrap items-center gap-2'>
          {/* The pipeline closed it without a person: an admin can put it back in the open queue. */}
          <Button size='sm' variant='outline' disabled={reopen.isPending} onClick={() => reopen.mutate()}>
            Reopen
          </Button>
        </div>
      )}
      {open && admin && (
        <div className='mt-1 flex flex-wrap items-center gap-2'>
          {item.document === null ? (
            <>
              <Button size='sm' disabled={blocker !== null || approveDraft.isPending} onClick={() => approveDraft.mutate()}>
                Approve
              </Button>
              <Button size='sm' variant='outline' onClick={() => onOpen({ kind: 'edit' })}>
                Edit
              </Button>
              <Button size='sm' variant='outline' onClick={() => onOpen({ kind: 'decision', decision: 'learning' })}>
                Keep as a learning
              </Button>
            </>
          ) : (
            <Button size='sm' onClick={() => onOpen({ kind: 'decision', decision: 'document' })}>
              Approve document
            </Button>
          )}
          <Button size='sm' variant='outline' onClick={() => onOpen({ kind: 'decision', decision: 'reject' })}>
            Reject
          </Button>
          {blocker !== null && <span className='text-xs text-muted-foreground'>{blocker}</span>}
        </div>
      )}
    </div>
  );
};

const TITLES: Record<Decision, string> = {
  learning: 'Keep as a learning',
  document: 'Approve the document',
  reject: 'Reject',
};

/** The form for one decision: an editable statement (kept as a learning), the proposed document, or a reason. */
const DecisionDialog = ({
  boardId,
  item,
  existing,
  decision,
  onClose,
}: {
  boardId: number;
  item: KbItem;
  existing: BoardDocument | null;
  decision: Decision;
  onClose: () => void;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const { markLocal } = useContext(KbMotion);
  const [statement, setStatement] = useState(item.statement);
  const [content, setContent] = useState(item.document?.content ?? '');
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: () => {
      if (decision === 'reject') return api.rejectProposal(item.id, item.version, reason);
      const approval: Approval = decision === 'learning' ? { as: 'learning', statement } : { as: 'document', content };
      return api.approveProposal(item.id, item.version, approval);
    },
    onSuccess: (decided) => {
      markLocal(decided.id);
      toast(`${decided.id} ${decided.status}`);
      refresh(client, boardId);
      onClose();
    },
    onError: (e) => {
      reportError(client, boardId, toast, e);
      if (e instanceof RequestError && e.body.currentItem !== undefined) onClose();
    },
  });

  const ready = decision === 'reject' ? reason.trim() !== '' : decision === 'learning' ? statement.trim() !== '' : content.trim() !== '';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${TITLES[decision]} · ${item.id}`} className='max-w-3xl'>
        <form
          className='grid gap-3'
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) decide.mutate();
          }}
        >
          {decision === 'learning' && (
            <>
              <p className='text-xs text-muted-foreground'>
                Kept as an approved learning, served to agents with the board's conventions, without changing any document.
              </p>
              <Label>
                Statement
                <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
              </Label>
            </>
          )}
          {decision === 'document' && item.document !== null && (
            <DocumentComparison
              boardId={boardId}
              proposed={item.document}
              existing={existing}
              proposedContent={
                <Label>
                  Content (editable)
                  <Textarea className='min-h-80 font-mono text-xs' value={content} onChange={(e) => setContent(e.target.value)} />
                </Label>
              }
            />
          )}
          {decision === 'reject' && (
            <Label>
              Reason (kept, so the same proposal can be recognised later)
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} required />
            </Label>
          )}
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={!ready || decide.isPending}>
              {decision === 'reject' ? 'Reject' : decision === 'learning' ? 'Keep as a learning' : 'Approve'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** A target's current text (a document's body, or the board's layer of an agent file); '' for a new document. */
const useTargetText = (boardId: number, kind: KnowledgeKind | null, name: string, isNew: boolean) =>
  useQuery({
    queryKey: ['kb-target-text', boardId, kind, name],
    queryFn: async () =>
      kind === 'doc'
        ? ((await api.knowledgeDoc(boardId, name)).find((d) => d.name === name)?.content ?? '')
        : (await api.agentSetFile(boardId, name)).content,
    enabled: kind !== null && name !== '' && !isNew,
  });

/** Edits the drafted section, then approves it: the content replaces the chosen heading's section, or is appended. */
const DraftEditor = ({ boardId, item, target, onClose }: { boardId: number; item: KbItemView; target: KbTarget; onClose: () => void }) => {
  const client = useQueryClient();
  const toast = useToast();
  const { markLocal } = useContext(KbMotion);
  const isNew = target.newDocument !== null;
  const text = useTargetText(boardId, target.kind, target.name, isNew);
  const current = isNew ? '' : text.data;
  const headings = current === undefined ? [] : spliceHeadings(current).map((h) => h.text);
  const wanted = item.draft?.section ?? target.section;
  const [section, setSection] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(item.draft?.content ?? null);
  // Until the admin picks one: the draft's heading when the target has it (matched as core's splice
  // matches it, ignoring case), otherwise append.
  const matched = wanted === null ? undefined : headings.find((h) => sameHeading(h, wanted.replace(/^#+\s*/, '')));
  const chosen = section ?? matched ?? '';
  // Without a draft (drafting failed), start from the section's current text.
  const body = content ?? (current === undefined ? null : chosen === '' ? '' : (sectionText(current, chosen) ?? ''));

  const approve = useMutation({
    mutationFn: () =>
      api.approveProposal(item.id, item.version, { as: 'draft', content: body ?? '', section: isNew || chosen === '' ? null : chosen }),
    onSuccess: (decided) => {
      markLocal(decided.id);
      toast(appliedText(decided));
      refresh(client, boardId);
      onClose();
    },
    onError: (e) => {
      reportError(client, boardId, toast, e);
      if (e instanceof RequestError && e.body.currentItem !== undefined) onClose();
    },
  });

  // Core refuses an edit of a stale draft (and drafts it again), so don't offer it.
  const stale = item.preview?.stale === true;
  return (
    <form
      className='grid gap-3'
      onSubmit={(e) => {
        e.preventDefault();
        if (body !== null && body.trim() !== '') approve.mutate();
      }}
    >
      {stale && <p className='text-xs text-muted-foreground'>The target changed since this draft; approve once it is drafted again.</p>}
      {isNew ? (
        <p className='text-xs text-muted-foreground'>The whole body of the new document {target.name}.</p>
      ) : (
        <Label>
          Section
          <Select value={chosen} onChange={(e) => setSection(e.target.value)} disabled={current === undefined}>
            <option value=''>Append as a new section</option>
            {headings.map((h, index) => (
              <option key={`${h}-${index}`} value={h}>
                Replace “{h}”
              </option>
            ))}
          </Select>
        </Label>
      )}
      <Label>
        {isNew ? 'Content' : 'Section text (with its heading)'}
        <Textarea
          className='min-h-80 font-mono text-xs'
          value={body ?? 'Loading…'}
          disabled={body === null}
          onChange={(e) => setContent(e.target.value)}
        />
      </Label>
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' size='sm' onClick={onClose}>
          Cancel
        </Button>
        <Button type='submit' size='sm' disabled={stale || body === null || body.trim() === '' || approve.isPending}>
          Approve
        </Button>
      </div>
    </form>
  );
};

type TargetKind = 'doc' | 'agent' | 'new';

/** Points the item at another target; its draft is cleared and it is drafted again there. */
const TargetEditor = ({
  board,
  item,
  agentFiles,
  onClose,
}: {
  board: Board;
  item: KbItem;
  agentFiles: readonly { kind: KnowledgeKind; path: string }[];
  onClose: () => void;
}) => {
  const { boardId, documents } = board;
  const client = useQueryClient();
  const toast = useToast();
  const target = item.target;
  const [kind, setKind] = useState<TargetKind>(
    target === null ? 'doc' : target.newDocument !== null ? 'new' : target.kind === 'doc' ? 'doc' : 'agent',
  );
  const [docName, setDocName] = useState(target?.kind === 'doc' && target.newDocument === null ? target.name : (documents[0]?.name ?? ''));
  const [agentPath, setAgentPath] = useState(target !== null && target.kind !== 'doc' ? target.name : (agentFiles[0]?.path ?? ''));
  const [section, setSection] = useState(target?.section ?? '');
  const [newName, setNewName] = useState(target !== null && target.newDocument !== null ? target.name : '');
  const [area, setArea] = useState(target?.newDocument?.area ?? '');
  const [audience, setAudience] = useState(target?.newDocument?.audience.join(', ') ?? '');
  const [description, setDescription] = useState(target?.newDocument?.description ?? '');

  const agent = agentFiles.find((f) => f.path === agentPath) ?? null;
  const name = kind === 'doc' ? docName : kind === 'agent' ? agentPath : newName.trim();
  const textKind = kind === 'doc' ? 'doc' : kind === 'agent' ? (agent?.kind ?? null) : null;
  const text = useTargetText(boardId, textKind, name, kind === 'new');
  const headings = text.data === undefined ? [] : [...new Set(spliceHeadings(text.data).map((h) => h.text))];

  const change = (): TargetChange | null => {
    const heading = section.trim() === '' ? null : section.trim();
    if (kind === 'doc') return docName === '' ? null : { kind: 'doc', name: docName, section: heading };
    if (kind === 'agent') return agent === null ? null : { kind: agent.kind, name: agent.path, section: heading };
    const people = audience
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '');
    if (newName.trim() === '' || area.trim() === '' || description.trim() === '') return null;
    const newDocument = { area: area.trim(), audience: people, description: description.trim() };
    return { kind: 'doc', name: newName.trim(), section: null, newDocument };
  };
  const next = change();

  const save = useMutation({
    mutationFn: (to: TargetChange) => api.changeProposalTarget(item.id, item.version, to),
    onSuccess: (changed) => {
      toast(`${changed.id} is being drafted again against ${changed.target?.name ?? 'its new target'}`);
      void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
      onClose();
    },
    onError: (e) => {
      reportError(client, boardId, toast, e);
      if (e instanceof RequestError && e.body.currentItem !== undefined) onClose();
    },
  });

  return (
    <form
      className='grid gap-3'
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== null) save.mutate(next);
      }}
    >
      <p className='text-xs text-muted-foreground'>The current draft is discarded and a new one is drafted against the chosen target.</p>
      <div className='flex flex-wrap gap-2' role='radiogroup' aria-label='Target kind'>
        {(
          [
            ['doc', 'A document'],
            ['agent', 'An agent file (board rules)'],
            ['new', 'A new document'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type='button'
            size='sm'
            role='radio'
            aria-checked={kind === value}
            variant={kind === value ? 'selected' : 'outline'}
            onClick={() => setKind(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {kind === 'doc' && (
        <Label>
          Document
          <Select value={docName} onChange={(e) => setDocName(e.target.value)}>
            {documents.length === 0 && <option value=''>No documents yet</option>}
            {documents.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </Select>
        </Label>
      )}
      {kind === 'agent' && (
        <Label>
          Agent file
          <Select value={agentPath} onChange={(e) => setAgentPath(e.target.value)}>
            {agentFiles.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
                {board.owned.has(f.path) ? ' (board file)' : ''}
              </option>
            ))}
          </Select>
        </Label>
      )}
      {kind !== 'new' && (
        <Label>
          Section (optional: an existing heading, or a new one; empty lets the drafter choose)
          <Input list={`kb-headings-${item.id}`} value={section} onChange={(e) => setSection(e.target.value)} />
          <datalist id={`kb-headings-${item.id}`}>
            {headings.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </Label>
      )}
      {kind === 'new' && (
        <div className='grid gap-2 sm:grid-cols-2'>
          <Label>
            Name
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder='testing_conventions' />
          </Label>
          <Label>
            Area
            <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder='testing' />
          </Label>
          <Label>
            Audience (agents, comma-separated)
            <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder='implementer, tester' />
          </Label>
          <Label>
            Description (one line)
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Label>
        </div>
      )}
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' size='sm' onClick={onClose}>
          Cancel
        </Button>
        <Button type='submit' size='sm' disabled={next === null || save.isPending}>
          Change target and redraft
        </Button>
      </div>
    </form>
  );
};

/** Edit an item: its drafted section (then approve), or its target (then it is drafted again). */
const EditDialog = ({
  board,
  item,
  agentFiles,
  onClose,
}: {
  board: Board;
  item: KbItemView;
  agentFiles: readonly { kind: KnowledgeKind; path: string }[];
  onClose: () => void;
}) => {
  const { target } = item;
  const [tab, setTab] = useState<'draft' | 'target'>(target === null ? 'target' : 'draft');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit · ${item.id}`} className='max-w-3xl'>
        <div className='grid gap-3'>
          <p className='text-sm font-medium'>{item.statement}</p>
          <div className='flex gap-2' role='tablist'>
            <Button
              type='button'
              size='sm'
              role='tab'
              aria-selected={tab === 'draft'}
              variant={tab === 'draft' ? 'selected' : 'ghost'}
              disabled={target === null}
              onClick={() => setTab('draft')}
            >
              Edit the draft
            </Button>
            <Button
              type='button'
              size='sm'
              role='tab'
              aria-selected={tab === 'target'}
              variant={tab === 'target' ? 'selected' : 'ghost'}
              onClick={() => setTab('target')}
            >
              Change the target
            </Button>
          </div>
          {target !== null && (
            <p className='text-xs'>
              <span className='font-medium'>Target: </span>
              <span className='font-mono'>{targetPath(target, board.owned)}</span>
            </p>
          )}
          {tab === 'draft' && target !== null ? (
            <DraftEditor boardId={board.boardId} item={item} target={target} onClose={onClose} />
          ) : (
            <TargetEditor board={board} item={item} agentFiles={agentFiles} onClose={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * KB items (`s<b>k<n>`): open ones as cards with their target, draft, evidence and flags; closed
 * ones collapsed. Members see them read-only; admins approve the draft, edit it or its target, keep
 * the statement as a learning, or reject it.
 */
export const KbProposals = ({
  boardId,
  admin,
  documents,
  agentEntries,
  onOpenDocument,
  live,
}: {
  boardId: number;
  admin: boolean;
  documents: readonly BoardDocument[];
  agentEntries: readonly AgentSetEntry[];
  onOpenDocument: (name: string) => void;
  /** The live connection, so a catch-up refetch after a reconnect doesn't animate. */
  live: LiveState;
}) => {
  // Decided and closed items only grow, so the newest are listed, with more on request.
  const [historyLimit, setHistoryLimit] = useState(KB_HISTORY_PAGE);
  const proposals = useQuery({
    queryKey: ['kb-proposals', boardId, historyLimit],
    queryFn: () => api.proposals(boardId, historyLimit),
    placeholderData: keepPreviousData,
    // Routing and drafting run in the background and `board.kb` hints report each step; while any
    // item waits for either, also check now and then in case a hint was lost.
    refetchInterval: (query) => (query.state.data?.open.some(inPipeline) === true ? PIPELINE_POLL_MS : false),
  });
  const [opened, setOpened] = useState<{ item: KbItemView; opening: Opening } | null>(null);

  const board: Board = { boardId, admin, documents, owned: ownedPaths(agentEntries), onOpenDocument };
  const { data } = proposals;
  const open = useMemo(() => [...(data?.open ?? [])].sort(byPriority), [data]);
  const decided = data?.decided ?? { items: [], total: 0 };
  const closed = data?.closed ?? { items: [], total: 0 };
  // Every listed card, in a list that keeps its identity until the data changes (what the motion compares).
  const listed = useMemo(
    () => (data === undefined ? undefined : [...open, ...data.decided.items, ...data.closed.items]),
    [data, open],
  );
  const motion = useCardMotion(listed, live, KB_MOTION);
  // The route lists at most KB_HISTORY_MAX of each group.
  const hasMore = historyLimit < KB_HISTORY_MAX && (decided.total > decided.items.length || closed.total > closed.items.length);
  const showMore = hasMore && (
    <Button
      size='sm'
      variant='outline'
      className='w-fit'
      onClick={() => setHistoryLimit(Math.min(historyLimit + KB_HISTORY_PAGE, KB_HISTORY_MAX))}
    >
      Show older
    </Button>
  );
  // Only open proposals can still replace a document; decided ones already did.
  const existingFor = (item: KbItem) =>
    item.status === 'open' && item.document !== null ? (documents.find((d) => d.name === item.document?.name) ?? null) : null;
  const agentFiles = agentEntries.flatMap((e) => {
    const kind = agentSetKind(e.path);
    return e.status !== 'orphaned' && kind !== null && PROSE_KINDS.includes(kind) ? [{ kind, path: e.path }] : [];
  });
  // Dialogs act on the item as it was when opened: if it changed meanwhile, the write is refused as a conflict.
  const current = opened?.item ?? null;

  return (
    <KbMotion.Provider value={{ locks: motion.locks, markLocal: motion.markLocal }}>
      <section
        ref={(el) => {
          motion.container.current = el;
        }}
        className='grid gap-2'
        data-testid='kb-proposals'
      >
        <h2 className='text-sm font-semibold'>Proposals</h2>
        <p className='text-xs text-muted-foreground'>
          Learnings and documents submitted by agents, routed to a target, checked for repeats and drafted as a change in the
          background. Nothing reaches the knowledge base or the agent set until an admin approves it. The most repeated come
          first, then the freshest evidence.
        </p>
        {proposals.isPending && <p className='text-sm text-muted-foreground'>Loading…</p>}
        {proposals.data !== undefined && open.length === 0 && <p className='text-sm text-muted-foreground'>No open proposals.</p>}
        {open.map((item) => (
          <ProposalCard
            key={item.id}
            board={board}
            item={item}
            existing={existingFor(item)}
            onOpen={(opening) => setOpened({ item, opening })}
          />
        ))}
        {decided.total > 0 && (
          <details className='text-sm' data-testid='kb-decided'>
            <summary className='cursor-pointer text-xs text-muted-foreground'>Approved and rejected ({decided.total})</summary>
            <div className='mt-2 grid gap-2'>
              {decided.items.map((item) => (
                <ProposalCard key={item.id} board={board} item={item} existing={null} onOpen={() => undefined} />
              ))}
              {decided.total > decided.items.length && showMore}
            </div>
          </details>
        )}
        {closed.total > 0 && (
          <details className='text-sm' data-testid='kb-closed'>
            <summary className='cursor-pointer text-xs text-muted-foreground'>
              Merged, suppressed or already covered ({closed.total})
            </summary>
            <div className='mt-2 grid gap-2'>
              {closed.items.map((item) => (
                <ProposalCard key={item.id} board={board} item={item} existing={null} onOpen={() => undefined} />
              ))}
              {closed.total > closed.items.length && showMore}
            </div>
          </details>
        )}
        {opened !== null && current !== null && opened.opening.kind === 'decision' && (
          <DecisionDialog
            key={`${current.id}-${opened.opening.decision}`}
            boardId={boardId}
            item={current}
            existing={existingFor(current)}
            decision={opened.opening.decision}
            onClose={() => setOpened(null)}
          />
        )}
        {opened !== null && current !== null && opened.opening.kind === 'edit' && (
          <EditDialog key={`${current.id}-edit`} board={board} item={current} agentFiles={agentFiles} onClose={() => setOpened(null)} />
        )}
      </section>
    </KbMotion.Provider>
  );
};
