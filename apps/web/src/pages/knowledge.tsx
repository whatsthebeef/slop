import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api, RequestError } from '@/lib/api';
import type { ImportResult } from '@/lib/api';
import { useToast } from '@/toast';

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

const summary = (r: ImportResult) =>
  [
    r.created.length > 0 ? `${r.created.length} added` : '',
    r.updated.length > 0 ? `${r.updated.length} updated` : '',
    r.unchanged.length > 0 ? `${r.unchanged.length} unchanged` : '',
  ]
    .filter((s) => s !== '')
    .join(', ');

/** The board's knowledge base: its documents, its agent set, and the ways to add to them. */
export const KnowledgePage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const toast = useToast();
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const kb = useQuery({ queryKey: ['kb', boardId], queryFn: () => api.knowledge(boardId) });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const [picked, setPicked] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const doc = useQuery({
    queryKey: ['kb-doc', boardId, viewing],
    queryFn: () => api.knowledgeDoc(boardId, viewing ?? ''),
    enabled: viewing !== null,
  });

  const done = (r: ImportResult) => {
    toast(summary(r) || 'Nothing to import');
    void client.invalidateQueries({ queryKey: ['kb', boardId] });
  };
  const importCatalog = useMutation({
    mutationFn: () => api.importCatalog(boardId, picked),
    onSuccess: (r) => {
      setPicked([]);
      done(r);
    },
    onError: (e) => toast(message(e)),
  });
  const upload = useMutation({
    mutationFn: (documents: { fileName: string; content: string }[]) => api.upload(boardId, documents),
    onSuccess: done,
    onError: (e) => toast(message(e)),
  });
  const fork = useMutation({
    mutationFn: () => api.forkAgentSet(boardId),
    onSuccess: done,
    onError: (e) => toast(message(e)),
  });

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].filter((f) => f.name.endsWith('.md'));
    event.target.value = '';
    if (files.length === 0) return;
    upload.mutate(
      await Promise.all(
        files.map(async (f) => ({ fileName: f.webkitRelativePath === '' ? f.name : f.webkitRelativePath, content: await f.text() })),
      ),
    );
  };

  if (board.data === undefined || kb.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;
  const admin = board.data.role === 'admin';
  const imported = new Set(kb.data.documents.map((d) => d.source.replace(/^catalog:|@\d+$/g, '')));

  return (
    <main className='mx-auto grid max-w-3xl gap-8 p-6'>
      <header className='flex items-center gap-3'>
        <Link className='text-sm text-muted-foreground hover:underline' to={`/boards/${boardId}`}>
          ← {board.data.name}
        </Link>
        <h1 className='font-semibold'>Knowledge</h1>
      </header>

      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Documents</h2>
        <p className='text-xs text-muted-foreground'>
          Served to agents through slop's MCP by area. The audience lists the agents that always get a document.
        </p>
        {kb.data.documents.length === 0 && <p className='text-sm text-muted-foreground'>No documents yet.</p>}
        <div className='grid gap-1'>
          {kb.data.documents.map((d) => (
            <button
              key={d.name}
              type='button'
              onClick={() => setViewing(d.name)}
              className='grid gap-0.5 rounded-md border bg-card p-2 text-left text-sm hover:bg-muted'
            >
              <span className='flex flex-wrap items-center gap-2'>
                <span className='font-medium'>{d.name}</span>
                {d.area !== null && <span className='rounded bg-muted px-1.5 text-xs'>{d.area}</span>}
                <span className='ml-auto text-xs text-muted-foreground'>
                  v{d.version} · {d.source}
                </span>
              </span>
              {d.description !== '' && <span className='text-xs text-muted-foreground'>{d.description}</span>}
              {d.audience.length > 0 && (
                <span className='text-xs text-muted-foreground'>always for: {d.audience.join(', ')}</span>
              )}
            </button>
          ))}
        </div>
        {admin && (
          <label className='mt-2 inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted'>
            Upload .md files
            <input type='file' accept='.md' multiple className='hidden' onChange={(e) => void onFiles(e)} />
          </label>
        )}
      </section>

      {admin && catalog.data !== undefined && (
        <section className='grid gap-2'>
          <h2 className='text-sm font-semibold'>Catalog</h2>
          <p className='text-xs text-muted-foreground'>
            Generic starter documents. Importing copies one into this board, where it can be edited freely.
          </p>
          {catalog.data.map((entry) => (
            <label key={entry.id} className='flex items-start gap-2 text-sm'>
              <input
                type='checkbox'
                className='mt-1'
                checked={picked.includes(entry.id)}
                onChange={(e) =>
                  setPicked(e.target.checked ? [...picked, entry.id] : picked.filter((id) => id !== entry.id))
                }
              />
              <span>
                <span className='font-medium'>{entry.id}</span>{' '}
                <span className='text-xs text-muted-foreground'>
                  v{entry.version}
                  {imported.has(entry.id) ? ' · imported' : ''}
                </span>
                <span className='block text-xs text-muted-foreground'>{entry.description}</span>
              </span>
            </label>
          ))}
          <Button size='sm' className='w-fit' disabled={picked.length === 0 || importCatalog.isPending} onClick={() => importCatalog.mutate()}>
            Import selected
          </Button>
        </section>
      )}

      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Agent set · version {kb.data.agentSet.version}</h2>
        <p className='text-xs text-muted-foreground'>
          Written into each checkout by <code>sstor init</code>, and refreshed by routines at the start of a run.
        </p>
        <ul className='grid gap-0.5 font-mono text-xs'>
          {kb.data.agentSet.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        {admin && (
          <Button variant='outline' size='sm' className='w-fit' disabled={fork.isPending} onClick={() => fork.mutate()}>
            Update from the catalog
          </Button>
        )}
      </section>

      {viewing !== null && (
        <Dialog open onOpenChange={(o) => !o && setViewing(null)}>
          <DialogContent title={viewing} className='max-w-3xl'>
            <pre className='overflow-x-auto text-xs whitespace-pre-wrap'>{doc.data?.[0]?.content ?? 'Loading…'}</pre>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
};
