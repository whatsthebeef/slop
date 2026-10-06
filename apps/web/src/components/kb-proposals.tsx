import { agentSetKind } from '@slop/core';
import type { Approval, DraftPreview, KbItem, KbItemView, KbTarget, KnowledgeKind, ProposedDocument } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MarkdownView } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Label, Select, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

type Decision = 'learning' | 'edit' | 'document' | 'reject';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

/** A document is `doc:<name>`, an agent-set file `<kind>:<path>`, so one select can list both. */
const targetKey = (kind: KnowledgeKind, name: string) => `${kind}:${name}`;

const targetText = (target: KbTarget): string => {
  if (target.newDocument !== null) return `new document ${target.name} (area ${target.newDocument.area})`;
  const where = target.kind === 'doc' ? `document ${target.name}` : `${target.name} (board rules)`;
  return target.section === null ? where : `${where} § ${target.section}`;
};

/** Items the pipeline closed without a decision: they leave the open queue but keep their links. */
const CLOSED_BY_PIPELINE: readonly KbItem['status'][] = ['merged', 'suppressed', 'covered'];

const outcomeText = (item: KbItem): string => {
  if (item.status === 'merged') return `Merged into ${item.duplicateOf ?? '?'} (a near-duplicate)`;
  if (item.status === 'suppressed') return `Suppressed: matches rejected ${item.suppressedBy ?? '?'}`;
  if (item.status === 'covered') {
    const by = item.coveredBy;
    if (by === null) return 'Already covered';
    return by.kind === 'item'
      ? `Already covered by approved ${by.id}`
      : `Already covered by ${by.knowledgeKind === 'doc' ? 'document ' : ''}${by.name}${by.section === null ? '' : ` § ${by.section}`}`;
  }
  if (item.status === 'rejected') return `Rejected: ${item.decisionReason ?? ''}`;
  if (item.outcome?.kind === 'applied') return `Applied to ${item.outcome.name} (v${item.outcome.version})`;
  return 'Approved as a learning';
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

/** Whether the background pipeline still has work to do on an item (routing, or its draft). */
const inPipeline = (item: KbItem) => item.status === 'open' && (item.processing === 'pending' || item.processing === 'routed');

/** What the background pipeline found: routing state, target, catalog flag, repeats and contradictions. */
const PipelineInfo = ({ item }: { item: KbItem }) => {
  const working = inPipeline(item) ? (item.processing === 'pending' ? 'Routing…' : 'Drafting…') : null;
  return (
    <div className='grid gap-1 text-xs' data-testid='pipeline-info'>
      <div className='flex flex-wrap items-center gap-2'>
        {working !== null && (
          <span className='text-muted-foreground'>
            {working}
            {item.processingError !== null && ` (retrying after: ${item.processingError})`}
          </span>
        )}
        {item.processing === 'failed' && (
          <span className='rounded-md border border-required-border bg-red-soft/15 px-1.5'>
            {item.target === null ? 'Routing' : 'Drafting'} failed: {item.processingError ?? 'unknown error'}
          </span>
        )}
        {item.target !== null && (
          <span>
            <span className='font-medium'>Target: </span>
            {targetText(item.target)}
          </span>
        )}
        {item.occurrenceCount > 1 && (
          <span className='rounded bg-muted px-1.5' title='Near-duplicates folded into this item'>
            seen {item.occurrenceCount}×
          </span>
        )}
        {item.catalogCandidate && (
          <span className='rounded bg-muted px-1.5 font-medium' title={item.catalogReason ?? undefined}>
            catalog candidate
          </span>
        )}
      </div>
      {item.catalogCandidate && item.catalogReason !== null && (
        <span className='text-muted-foreground'>Holds for any project: {item.catalogReason}</span>
      )}
      {item.contradicts.length > 0 && (
        <div className='rounded-md border border-required-border bg-red-soft/15 p-2' data-testid='contradictions'>
          <span className='font-medium'>Contradicts:</span>
          <ul className='ml-4 list-disc'>
            {item.contradicts.map((c) => (
              <li key={`${c.kind}:${c.ref}`}>
                {c.ref}
                {c.note !== '' && ` — ${c.note}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.extraEvidence.length > 0 && (
        <details>
          <summary className='cursor-pointer text-muted-foreground'>More evidence ({item.extraEvidence.length})</summary>
          <ul className='mt-1 ml-4 list-disc'>
            {item.extraEvidence.map((e) => (
              <li key={e.itemId} className='whitespace-pre-wrap'>
                {e.itemId}
                {e.globIds.length > 0 && ` (${e.globIds.join(', ')})`}: {e.evidence}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/** A drafted change: its rationale and the diff approving it would make to the target as it is now. */
const DraftView = ({ rationale, preview }: { rationale: string | null; preview: DraftPreview }) => (
  <div className='grid gap-1 text-xs' data-testid='draft'>
    {rationale !== null && (
      <span>
        <span className='font-medium'>Draft: </span>
        {rationale}
      </span>
    )}
    {preview.stale && <span className='text-muted-foreground'>The target changed since this draft; drafting it again…</span>}
    <pre className='max-h-80 overflow-auto rounded-md border text-xs' data-testid='draft-diff'>
      {preview.diff.map((line, index) =>
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
      )}
    </pre>
  </div>
);

const ProposalCard = ({
  boardId,
  item,
  existing,
  admin,
  onDecide,
}: {
  boardId: number;
  item: KbItemView;
  /** For an open document proposal: the board document of the same name, if there is one. */
  existing: BoardDocument | null;
  admin: boolean;
  onDecide: (decision: Decision) => void;
}) => {
  const [showDocument, setShowDocument] = useState(false);
  const open = item.status === 'open';
  const client = useQueryClient();
  const toast = useToast();
  const preview = open && item.draft !== null ? item.preview : null;
  const approveDraft = useMutation({
    mutationFn: () => api.approveProposal(item.id, item.version, { as: 'draft' }),
    onSuccess: (decided) => {
      toast(`${decided.id} ${decided.status}`);
      void client.invalidateQueries({ queryKey: ['kb', boardId] });
      void client.invalidateQueries({ queryKey: ['kb-doc', boardId] });
    },
    // A stale draft is refused and drafted again; either way the list shows the current state.
    onError: (e) => toast(message(e)),
    onSettled: () => void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] }),
  });
  return (
    <div className='grid gap-1.5 rounded-md border bg-card p-3 text-sm' data-testid={`proposal-${item.id}`}>
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
      <p className='text-xs whitespace-pre-wrap text-muted-foreground'>
        <span className='font-medium'>Evidence: </span>
        {item.evidence}
      </p>
      <p className='text-xs text-muted-foreground'>
        {item.suggestedTarget !== null && <>Suggested target: {item.suggestedTarget} · </>}
        {item.sourceGlobIds.length > 0 ? `From ${item.sourceGlobIds.join(', ')}` : 'No source glob'}
      </p>
      <PipelineInfo item={item} />
      {preview !== null && <DraftView rationale={item.rationale} preview={preview} />}
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
          {outcomeText(item)}{' '}
          {item.decidedBy !== null && (
            <span className='text-muted-foreground'>
              · {item.decidedBy} · {when(item.decidedAt)}
            </span>
          )}
        </p>
      )}
      {open && admin && (
        <div className='mt-1 flex flex-wrap gap-2'>
          {item.document === null ? (
            <>
              {preview !== null && (
                <Button size='sm' disabled={preview.stale || approveDraft.isPending} onClick={() => approveDraft.mutate()}>
                  Approve draft
                </Button>
              )}
              <Button size='sm' variant={preview === null ? 'default' : 'outline'} onClick={() => onDecide('learning')}>
                Approve as learning
              </Button>
              <Button size='sm' variant='outline' onClick={() => onDecide('edit')}>
                Apply to a document or agent file
              </Button>
            </>
          ) : (
            <Button size='sm' onClick={() => onDecide('document')}>
              Approve document
            </Button>
          )}
          <Button size='sm' variant='outline' onClick={() => onDecide('reject')}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
};

const TITLES: Record<Decision, string> = {
  learning: 'Approve as a learning',
  edit: 'Apply to a document or agent file',
  document: 'Approve the document',
  reject: 'Reject',
};

/** The form for one decision: an editable statement, a target and its new content, the document, or a reason. */
const DecisionDialog = ({
  boardId,
  item,
  existing,
  decision,
  targets,
  onClose,
}: {
  boardId: number;
  item: KbItem;
  existing: BoardDocument | null;
  decision: Decision;
  targets: readonly { kind: KnowledgeKind; name: string }[];
  onClose: () => void;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const suggested = targets.find((t) => t.name === item.suggestedTarget || t.name === `${item.suggestedTarget ?? ''}.md`);
  const [statement, setStatement] = useState(item.statement);
  const [target, setTarget] = useState(suggested === undefined ? '' : targetKey(suggested.kind, suggested.name));
  const [content, setContent] = useState(item.document?.content ?? '');
  const [loaded, setLoaded] = useState(decision !== 'edit');
  // Agent-set files: what the edit writes (the board's overlay or its whole file) and the catalog text beside it.
  const [layer, setLayer] = useState<{ kind: 'overlay' | 'file'; catalog: string | null } | null>(null);
  const [reason, setReason] = useState('');
  const chosen = targets.find((t) => targetKey(t.kind, t.name) === target) ?? null;

  const chosenKind = chosen?.kind ?? null;
  const chosenName = chosen?.name ?? null;

  // Pre-fill the editor with the target's current content: a document's body (without frontmatter),
  // or an agent-set file's board layer (its overlay, or the whole file the board owns).
  useEffect(() => {
    if (decision !== 'edit' || chosenKind === null || chosenName === null) return;
    let cancelled = false;
    setLoaded(false);
    setLayer(null);
    const current =
      chosenKind === 'doc'
        ? api
            .knowledgeDoc(boardId, chosenName)
            .then((docs) => ({ text: docs.find((d) => d.name === chosenName)?.content ?? '', layer: null }))
        : api
            .agentSetFile(boardId, chosenName)
            .then((file) => ({ text: file.content, layer: { kind: file.layer, catalog: file.catalog } }));
    current
      .then((loadedTarget) => {
        if (cancelled) return;
        setContent(loadedTarget.text);
        setLayer(loadedTarget.layer);
        setLoaded(true);
      })
      .catch((e: unknown) => toast(message(e)));
    return () => {
      cancelled = true;
    };
  }, [boardId, decision, chosenKind, chosenName, toast]);

  const decide = useMutation({
    mutationFn: () => {
      if (decision === 'reject') return api.rejectProposal(item.id, item.version, reason);
      const approval: Approval =
        decision === 'learning'
          ? { as: 'learning', statement }
          : decision === 'document'
            ? { as: 'document', content }
            : { as: 'edit', target: { kind: chosen?.kind ?? 'doc', name: chosen?.name ?? '' }, content, statement };
      return api.approveProposal(item.id, item.version, approval);
    },
    onSuccess: (decided) => {
      toast(`${decided.id} ${decided.status}`);
      void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
      void client.invalidateQueries({ queryKey: ['kb', boardId] });
      void client.invalidateQueries({ queryKey: ['kb-doc', boardId] });
      onClose();
    },
    onError: (e) => {
      toast(message(e));
      // Someone else decided it meanwhile: show the current state.
      if (e instanceof RequestError && e.body.currentItem !== undefined) {
        void client.invalidateQueries({ queryKey: ['kb-proposals', boardId] });
        onClose();
      }
    },
  });

  const ready =
    decision === 'reject'
      ? reason.trim() !== ''
      : decision === 'learning'
        ? statement.trim() !== ''
        : decision === 'document'
          ? content.trim() !== ''
          : chosen !== null && loaded && content.trim() !== '' && statement.trim() !== '';

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
          {(decision === 'learning' || decision === 'edit') && (
            <Label>
              Statement
              <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
            </Label>
          )}
          {decision === 'edit' && (
            <>
              <Label>
                Target
                <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value=''>Choose a document or agent file…</option>
                  {targets.map((t) => (
                    <option key={targetKey(t.kind, t.name)} value={targetKey(t.kind, t.name)}>
                      {t.kind === 'doc' ? `Document: ${t.name}` : t.name}
                    </option>
                  ))}
                </Select>
              </Label>
              {chosen !== null && (
                <>
                  {layer?.kind === 'overlay' && layer.catalog !== null && (
                    <details className='text-xs'>
                      <summary className='cursor-pointer text-muted-foreground'>Catalog version (read-only)</summary>
                      <pre className='mt-1 max-h-64 overflow-auto rounded-md border p-2 whitespace-pre-wrap'>{layer.catalog}</pre>
                    </details>
                  )}
                  <Label>
                    {chosen.kind === 'doc'
                      ? 'New content (its frontmatter is kept unless you add one)'
                      : layer?.kind === 'overlay'
                        ? chosen.kind === 'settings'
                          ? "Board settings (JSON merged onto the catalog's; approving raises the board's agent-set version)"
                          : "Board rules (appended to the catalog file under “## Board rules”; approving raises the board's agent-set version)"
                        : "New content of the board's own file (approving raises the board's agent-set version)"}
                    <Textarea
                      className='min-h-80 font-mono text-xs'
                      value={loaded ? content : 'Loading…'}
                      disabled={!loaded}
                      onChange={(e) => setContent(e.target.value)}
                    />
                  </Label>
                </>
              )}
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
              {decision === 'reject' ? 'Reject' : 'Approve'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * KB items (`s<b>k<n>`) submitted by agents: open ones first, decided ones collapsed. Members see
 * them read-only; admins approve (as a learning, as an edit, or the proposed document) or reject.
 */
export const KbProposals = ({
  boardId,
  admin,
  documents,
  agentFiles,
}: {
  boardId: number;
  admin: boolean;
  documents: readonly BoardDocument[];
  agentFiles: readonly string[];
}) => {
  const proposals = useQuery({
    queryKey: ['kb-proposals', boardId],
    queryFn: () => api.proposals(boardId),
    // Routing and drafting run in the background: poll while any item waits for either.
    refetchInterval: (query) => ((query.state.data ?? []).some(inPipeline) ? 5_000 : false),
  });
  const [deciding, setDeciding] = useState<{ item: KbItemView; decision: Decision } | null>(null);

  const items = proposals.data ?? [];
  const open = items.filter((i) => i.status === 'open');
  const decided = items.filter((i) => i.status === 'approved' || i.status === 'rejected').reverse();
  const closed = items.filter((i) => CLOSED_BY_PIPELINE.includes(i.status)).reverse();
  // Only open proposals can still replace a document; decided ones already did.
  const existingFor = (item: KbItem) =>
    item.status === 'open' && item.document !== null ? (documents.find((d) => d.name === item.document?.name) ?? null) : null;
  const targets = [
    ...documents.map((d) => ({ kind: 'doc' as const, name: d.name })),
    ...agentFiles.flatMap((path) => {
      const kind = agentSetKind(path);
      return kind === null ? [] : [{ kind, name: path }];
    }),
  ];

  return (
    <section className='grid gap-2' data-testid='kb-proposals'>
      <h2 className='text-sm font-semibold'>Proposals</h2>
      <p className='text-xs text-muted-foreground'>
        Learnings and documents submitted by agents, routed to a target and checked for repeats in the background. Nothing
        reaches the knowledge base or the agent set until an admin approves it.
      </p>
      {proposals.isPending && <p className='text-sm text-muted-foreground'>Loading…</p>}
      {proposals.data !== undefined && open.length === 0 && <p className='text-sm text-muted-foreground'>No open proposals.</p>}
      {open.map((item) => (
        <ProposalCard
          key={item.id}
          boardId={boardId}
          item={item}
          existing={existingFor(item)}
          admin={admin}
          onDecide={(decision) => setDeciding({ item, decision })}
        />
      ))}
      {decided.length > 0 && (
        <details className='text-sm'>
          <summary className='cursor-pointer text-xs text-muted-foreground'>Decided ({decided.length})</summary>
          <div className='mt-2 grid gap-2'>
            {decided.map((item) => (
              <ProposalCard key={item.id} boardId={boardId} item={item} existing={null} admin={admin} onDecide={() => undefined} />
            ))}
          </div>
        </details>
      )}
      {closed.length > 0 && (
        <details className='text-sm' data-testid='kb-closed'>
          <summary className='cursor-pointer text-xs text-muted-foreground'>
            Merged, suppressed or already covered ({closed.length})
          </summary>
          <div className='mt-2 grid gap-2'>
            {closed.map((item) => (
              <ProposalCard key={item.id} boardId={boardId} item={item} existing={null} admin={admin} onDecide={() => undefined} />
            ))}
          </div>
        </details>
      )}
      {deciding !== null && (
        <DecisionDialog
          key={`${deciding.item.id}-${deciding.decision}`}
          boardId={boardId}
          item={deciding.item}
          existing={existingFor(deciding.item)}
          decision={deciding.decision}
          targets={targets}
          onClose={() => setDeciding(null)}
        />
      )}
    </section>
  );
};
