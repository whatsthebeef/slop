import { lineDiff } from '@slop/core';
import type { AgentSetEntry, AgentSetEntryStatus } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Label, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

const STATUS_TEXT: Record<AgentSetEntryStatus, string> = {
  catalog: 'catalog',
  overlay: 'catalog + board rules',
  board_file: 'board file',
  override: 'Overrides the catalog',
  orphaned: 'orphaned: no longer in the catalog, not served',
};

/** A two-way line diff: lines only in the board's file in red, lines only in the catalog in green. */
export const LineDiff = ({ board, catalog }: { board: string; catalog: string }) => (
  <pre className='max-h-96 overflow-auto rounded-md border text-xs'>
    {lineDiff(board, catalog).map((line, i) => (
      <div
        key={i}
        className={
          line.op === 'removed'
            ? 'bg-red-500/10 text-red-700 dark:text-red-300'
            : line.op === 'added'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'text-muted-foreground'
        }
      >
        {line.op === 'removed' ? '- ' : line.op === 'added' ? '+ ' : '  '}
        {line.text}
      </div>
    ))}
  </pre>
);

/**
 * One agent-set file: the served text and, for a board file overriding a catalog file, its diff
 * against the catalog and (admins) the switch back to the catalog file plus board rules.
 */
const AgentSetFileDialog = ({
  boardId,
  entry,
  admin,
  onClose,
}: {
  boardId: number;
  entry: AgentSetEntry;
  admin: boolean;
  onClose: () => void;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const [overlay, setOverlay] = useState('');
  const file = useQuery({
    queryKey: ['kb-agent-file', boardId, entry.path],
    queryFn: () => api.agentSetFile(boardId, entry.path),
  });
  const reset = useMutation({
    mutationFn: () => api.useCatalogVersion(boardId, entry.path, overlay),
    onSuccess: () => {
      toast(`${entry.path} now follows the catalog`);
      void client.invalidateQueries({ queryKey: ['kb', boardId] });
      void client.invalidateQueries({ queryKey: ['kb-agent-file', boardId] });
      onClose();
    },
    onError: (e) => toast(message(e)),
  });

  const view = file.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={entry.path} className='max-w-3xl'>
        {view === undefined ? (
          <p className='text-sm text-muted-foreground'>Loading…</p>
        ) : view.status === 'override' && view.catalog !== null ? (
          <div className='grid gap-3'>
            <p className='text-xs text-muted-foreground'>
              This board keeps a whole copy of the file, so catalog changes don't reach it. Lines only in the board's copy are
              marked −, lines only in the catalog +.
            </p>
            <LineDiff board={view.content} catalog={view.catalog} />
            {admin && (
              <form
                className='grid gap-2'
                onSubmit={(e) => {
                  e.preventDefault();
                  reset.mutate();
                }}
              >
                <Label>
                  Board rules (optional; appended to the catalog file under “## Board rules”)
                  <Textarea className='min-h-24 font-mono text-xs' value={overlay} onChange={(e) => setOverlay(e.target.value)} />
                </Label>
                <Button type='submit' size='sm' className='w-fit' disabled={reset.isPending}>
                  Use catalog version + Board rules
                </Button>
              </form>
            )}
          </div>
        ) : (
          <div className='grid gap-2'>
            {view.status === 'overlay' && (
              <p className='text-xs text-muted-foreground'>The catalog file with this board's rules appended.</p>
            )}
            <pre className='overflow-x-auto text-xs whitespace-pre-wrap'>{view.served ?? view.content}</pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/** The board's agent-set files with how each is served; catalog files with no board layer come straight from the catalog. */
export const AgentSetFiles = ({
  boardId,
  admin,
  entries,
}: {
  boardId: number;
  admin: boolean;
  entries: readonly AgentSetEntry[];
}) => {
  const [viewing, setViewing] = useState<AgentSetEntry | null>(null);
  return (
    <>
      <ul className='grid gap-0.5 text-xs'>
        {entries.map((e) => (
          <li key={e.path}>
            <button type='button' className='flex w-full items-center gap-2 rounded px-1 text-left hover:bg-muted' onClick={() => setViewing(e)}>
              <span className='font-mono'>{e.path}</span>
              <span
                className={
                  e.status === 'override' || e.status === 'orphaned'
                    ? 'rounded bg-amber-500/15 px-1.5 text-amber-800 dark:text-amber-200'
                    : 'text-muted-foreground'
                }
              >
                {STATUS_TEXT[e.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {viewing !== null && <AgentSetFileDialog boardId={boardId} entry={viewing} admin={admin} onClose={() => setViewing(null)} />}
    </>
  );
};
