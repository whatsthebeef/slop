import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router';
import type { BoardShellContext } from '@/components/board-shell';
import { PasteIntoInbox } from '@/components/paste-into-inbox';
import { Button } from '@/components/ui/button';
import { CreateGlobDialog } from '@/components/create-glob';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { BoardView, GlobView, InboxItemView, NewGlob } from '@/lib/api';
import {
  attachableGlobs,
  filterImported,
  IMPORTED_PAGE,
  importedPage,
  inboxCreateKey,
  inboxRequest,
  pendingCount,
  processingNote,
  visibleItems,
} from '@/lib/inbox';
import { globsKey, inboxKey, useLiveInbox } from '@/lib/live';
import { usePageContext } from '@/lib/page-context';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';

const message = (error: unknown) =>
  error instanceof RequestError ? error.body.message : 'Something went wrong';
const day = (iso: string) => iso.slice(0, 10);
/** Hints are lost in hidden tabs, so an item being summarised is also polled. */
const POLL_MS = 15_000;

const globLink = (boardId: number, globId: string) =>
  `/boards/${String(boardId)}?glob=${encodeURIComponent(globId)}`;

/** Attach to the suggested globs (ticked) and any other open glob of the board. */
const AttachDialog = ({
  boardId,
  item,
  globs,
  initial,
  open,
  onOpenChange,
  onDone,
}: {
  boardId: number;
  item: InboxItemView;
  globs: readonly GlobView[];
  /** The globs ticked when it opens. */
  initial: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) => {
  const toast = useToast();
  const suggested = item.suggestions ?? [];
  const [picked, setPicked] = useState<string[]>([...initial]);
  const [extra, setExtra] = useState('');
  const choices = attachableGlobs(globs, item).filter((g) => !picked.includes(g.id));
  const attach = useMutation({
    mutationFn: () => api.attachInbox(boardId, item.id, extra === '' ? picked : [...picked, extra]),
    onSuccess: () => {
      toast('Attached');
      onDone();
      onOpenChange(false);
    },
    onError: (e) => toast(message(e)),
  });
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const count = picked.length + (extra === '' ? 0 : 1);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Attach to globs">
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            It appears on each glob as an attachment, in its context, and its choices are read
            from it.
          </p>
          {suggested.map((s) => (
            <label key={s.globId} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.includes(s.globId)}
                onChange={() => toggle(s.globId)}
              />
              <span>
                <span className="font-mono text-xs">{s.globId}</span> {s.title}
                <span className="block text-xs text-muted-foreground">{s.reason}</span>
              </span>
            </label>
          ))}
          <Select
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            aria-label="Another glob"
          >
            <option value="">Another glob…</option>
            {choices.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} {g.title}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={count === 0 || attach.isPending} onClick={() => attach.mutate()}>
              Attach to {count} {count === 1 ? 'glob' : 'globs'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const Card = ({
  boardId,
  board,
  item,
  globs,
  highlighted,
  onChanged,
}: {
  boardId: number;
  board: BoardView | undefined;
  item: InboxItemView;
  globs: readonly GlobView[];
  highlighted: boolean;
  onChanged: () => void;
}) => {
  const toast = useToast();
  const [showText, setShowText] = useState(highlighted);
  // The globs ticked in the attach dialog while it is open.
  const [attaching, setAttaching] = useState<readonly string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Create glob: the dialog's request text and creation key once the item's text is loaded; `made` is the glob it already made.
  const [creating, setCreating] = useState<{ request: string; key: string } | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const prepare = useMutation({
    mutationFn: async () => {
      const [existing, full] = await Promise.all([
        api.inboxGlob(boardId, item.id),
        api.inboxItem(boardId, item.id),
      ]);
      return { existing: existing.globId, request: inboxRequest(item, full.text ?? '') };
    },
    onSuccess: ({ existing, request }) => {
      if (existing !== null) setMade(existing);
      else setCreating({ request, key: inboxCreateKey(item.id, false) });
    },
    onError: (e) => toast(message(e)),
  });
  const detail = useQuery({
    queryKey: [...inboxKey(boardId), item.id],
    queryFn: () => api.inboxItem(boardId, item.id),
    enabled: showText,
  });
  const settle = useMutation({
    mutationFn: (action: 'keep' | 'discard') =>
      action === 'keep' ? api.keepInbox(boardId, item.id) : api.discardInbox(boardId, item.id),
    onSuccess: onChanged,
    onError: (e) => toast(message(e)),
  });
  const detach = useMutation({
    mutationFn: (globId: string) => api.detachInbox(boardId, item.id, [globId]),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: globsKey(boardId) });
      toast('Detached');
      onChanged();
    },
    onError: (e) => toast(message(e)),
  });
  // A decision glob in Planning with this item attached as its source; promoting again returns the same glob.
  const client = useQueryClient();
  const promote = useMutation({
    mutationFn: () => api.promoteInbox(boardId, item.id),
    onSuccess: ({ glob }) => {
      void client.invalidateQueries({ queryKey: globsKey(boardId) });
      toast(`Promoted to decision ${glob.id}`);
      onChanged();
    },
    onError: (e) => toast(message(e)),
  });
  // The glob's attachment links here: bring the item into view.
  useEffect(() => {
    if (highlighted)
      document.getElementById(`inbox-${String(item.id)}`)?.scrollIntoView({ block: 'center' });
  }, [highlighted, item.id]);
  const note = processingNote(item);
  const suggestions = item.suggestions ?? [];
  const attached = item.attachedTo ?? [];
  const origin = item.status === 'archived' || (item.source !== undefined && item.source !== 'paste') ? (item.source ?? 'Import') : 'Paste';
  const source =
    item.sourceLabel === undefined || item.sourceLabel === ''
      ? origin
      : `${origin} · ${item.sourceLabel}`;
  return (
    <li
      id={`inbox-${String(item.id)}`}
      data-testid="inbox-item"
      className={cn('grid gap-2 rounded-md border bg-card p-3', highlighted && 'ring-2 ring-ring')}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Titles and summaries come from outside (pasted text, a model): plain text only. */}
        <h2 className="text-sm font-semibold break-words">{item.title}</h2>
        <span className="text-xs text-muted-foreground">
          {source} · {day(item.occurredAt)}
        </span>
        {item.status !== 'new' && (
          <span className="rounded-full bg-muted px-2 text-xs">{item.status}</span>
        )}
      </div>
      {item.summary !== undefined && item.summary !== null ? (
        <p className="text-sm whitespace-pre-wrap break-words">{item.summary}</p>
      ) : (
        <>
          {item.excerpt !== undefined && item.excerpt !== '' && (
            <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
              {item.excerpt}
            </p>
          )}
          {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
        </>
      )}
      {suggestions.length > 0 && (
        <ul className="grid gap-1" aria-label="Suggested globs">
          {suggestions.map((s) => (
            <li key={s.globId} className="flex flex-wrap items-center gap-x-2 text-xs">
              <Link className="underline" to={globLink(boardId, s.globId)}>
                <span className="font-mono">{s.globId}</span> {s.title}
              </Link>
              <span className="text-muted-foreground">{s.reason}</span>
              <Button size="sm" variant="outline" onClick={() => setAttaching([s.globId])}>
                Attach
              </Button>
            </li>
          ))}
        </ul>
      )}
      {attached.length > 0 && (
        <p className="flex flex-wrap gap-1 text-xs">
          <span className="text-muted-foreground">On:</span>
          {attached.map((a) => (
            <span key={a.globId} className="inline-flex items-center gap-1 rounded-full border px-2">
              <Link className="underline" to={globLink(boardId, a.globId)}>
                {a.globId}
              </Link>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Detach from ${a.globId}`}
                disabled={detach.isPending}
                onClick={() => {
                  if (window.confirm(`Detach "${item.title}" from ${a.globId} (${a.title})? It leaves that glob's context and choices.`))
                    detach.mutate(a.globId);
                }}
              >
                Detach
              </button>
            </span>
          ))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {item.status !== 'discarded' && (
          <Button size="sm" onClick={() => setAttaching(suggestions.map((s) => s.globId))}>
            Attach to…
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
          Create glob
        </Button>
        {item.status !== 'discarded' && (
          <Button size="sm" variant="outline" disabled={promote.isPending} onClick={() => promote.mutate()}>
            Promote to decision
          </Button>
        )}
        {item.status === 'new' && (
          <Button
            size="sm"
            variant="outline"
            disabled={settle.isPending}
            onClick={() => settle.mutate('keep')}
          >
            Keep
          </Button>
        )}
        {item.status !== 'attached' &&
          (confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={settle.isPending}
                onClick={() => settle.mutate('discard')}
              >
                Discard it
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                Keep it here
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              Discard
            </Button>
          ))}
        <Button size="sm" variant="ghost" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Hide text' : 'Show text'}
        </Button>
      </div>
      {showText && (
        <div className="max-h-96 overflow-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap break-words">
          {detail.isError ? 'Could not load the text.' : (detail.data?.text ?? 'Loading…')}
        </div>
      )}
      {made !== null && (
        <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="inbox-already-made">
          <span>
            <Link className="underline" to={globLink(boardId, made)}>
              {made}
            </Link>{' '}
            was already made from this item.
          </span>
          <Link className="underline" to={globLink(boardId, made)}>
            Open it
          </Link>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setMade(null);
              setCreating({ request: inboxRequest(item, detail.data?.text ?? item.excerpt ?? ''), key: inboxCreateKey(item.id, true) });
            }}
          >
            Create another
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
            Cancel
          </Button>
        </p>
      )}
      {creating !== null && board !== undefined && (
        <CreateGlobDialog
          board={board}
          groups={[...new Set(globs.flatMap((g) => (g.group === null ? [] : [g.group])))].sort()}
          open
          initialRequest={creating.request}
          fromInbox={{ id: item.id, title: item.title, key: creating.key }}
          onOpenChange={(o) => !o && setCreating(null)}
          onCreate={async (input: NewGlob) => {
            const glob = await api.createGlob(boardId, input).catch((error: unknown) => {
              throw error instanceof RequestError ? new Error(error.body.message) : error;
            });
            toast(`Created ${glob.id} with this item attached`);
            onChanged();
            return glob;
          }}
        />
      )}
      {attaching !== null && (
        <AttachDialog
          boardId={boardId}
          item={item}
          globs={globs}
          initial={attaching}
          open
          onOpenChange={(o) => !o && setAttaching(null)}
          onDone={onChanged}
        />
      )}
    </li>
  );
};

/** The board's inbox (spec, Inbox and ingest): pasted notes, threads and documents, each with a summary and suggested globs, to attach, keep or discard. */
export const InboxPage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const live = useLiveInbox(boardId);
  const { headerActions } = useOutletContext<BoardShellContext>();
  const [params] = useSearchParams();
  const target = Number(params.get('item'));
  usePageContext({ type: 'inbox', ...(Number.isInteger(target) && target > 0 ? { id: String(target) } : {}) });
  const [pasting, setPasting] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [imported, setImported] = useState(false);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(IMPORTED_PAGE);
  const link = Number.isInteger(target) && target > 0 ? target : null;
  // The imported items are always loaded: their count labels the toggle, and the text filter runs over them here.
  const archived = useQuery({
    queryKey: [...inboxKey(boardId), 'archived'],
    queryFn: () => api.inbox(boardId, 'archived'),
  });
  // An `?item=` link opens its item whatever its status: an archived one switches to the imported view.
  const linked = useQuery({
    queryKey: [...inboxKey(boardId), 'linked', link],
    queryFn: () => api.inboxItem(boardId, link ?? 0),
    enabled: link !== null,
    retry: false,
  });
  const linkedArchived = linked.data?.status === 'archived';
  useEffect(() => {
    if (linkedArchived) setImported(true);
  }, [linkedArchived, link]);
  const items = useQuery({
    queryKey: inboxKey(boardId),
    queryFn: () => api.inbox(boardId),
    refetchInterval: (q) => (pendingCount(q.state.data ?? []) > 0 ? POLL_MS : false),
  });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const changed = () => {
    void client.invalidateQueries({ queryKey: inboxKey(boardId) });
    void client.invalidateQueries({ queryKey: globsKey(boardId) });
  };
  const shown = visibleItems(items.data ?? [], onlyNew);
  const matches = filterImported(archived.data ?? [], filter);
  const importedShown = importedPage(matches, limit, linkedArchived ? link : null);

  return (
    <div className="mx-auto grid max-w-3xl gap-3 px-5 py-4" data-testid="inbox" data-live={live}>
      <h1 className="sr-only">Inbox</h1>
      {headerActions !== null &&
        createPortal(
          <Button size="sm" className="text-sm" onClick={() => setPasting(true)}>
            <Plus className="h-4 w-4" /> Paste into inbox
          </Button>,
          headerActions,
        )}
      <PasteIntoInbox
        boardId={boardId}
        open={pasting}
        onOpenChange={setPasting}
        onAdded={changed}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {!imported && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            Only items that are new
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={imported} onChange={(e) => setImported(e.target.checked)} />
          Imported ({archived.data === undefined ? '…' : archived.data.length})
        </label>
        {imported && (
          <Input
            className="max-w-xs"
            type="search"
            aria-label="Filter imported items"
            placeholder="Filter by title or text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setLimit(IMPORTED_PAGE);
            }}
          />
        )}
      </div>
      {imported ? (
        archived.isError ? (
          <p className="text-sm text-red">Could not load the imported items.</p>
        ) : archived.data === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {filter.trim() === '' ? 'Nothing has been imported.' : 'No imported item matches.'}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="imported-count">
              {matches.length === archived.data.length
                ? `${String(matches.length)} imported`
                : `${String(matches.length)} of ${String(archived.data.length)} imported`}
            </p>
            <ul className="grid gap-3">
              {importedShown.map((item) => (
                <Card
                  key={item.id}
                  boardId={boardId}
                  board={board.data}
                  item={item}
                  globs={globs.data ?? []}
                  highlighted={item.id === target}
                  onChanged={changed}
                />
              ))}
            </ul>
            {matches.length > limit && (
              <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + IMPORTED_PAGE)}>
                Show more ({matches.length - limit} left)
              </Button>
            )}
          </>
        )
      ) : items.isError ? (
        <p className="text-sm text-red">Could not load the inbox.</p>
      ) : items.data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing here. Paste meeting notes, a thread or a document to file it against your globs.
        </p>
      ) : (
        <ul className="grid gap-3">
          {shown.map((item) => (
            <Card
              key={item.id}
              boardId={boardId}
              board={board.data}
              item={item}
              globs={globs.data ?? []}
              highlighted={item.id === target}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
