import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { useParams } from 'react-router';
import { AgentSetFiles, LineDiff } from '@/components/agent-set-files';
import { KbProposals } from '@/components/kb-proposals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api, RequestError } from '@/lib/api';
import type { ImportResult } from '@/lib/api';
import { useLiveKnowledge } from '@/lib/live';
import { usePageContext } from '@/lib/page-context';
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

/** The board's knowledge base: its documents, proposals for it, its agent set, and the ways to add to them. */
export const KnowledgePage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const toast = useToast();
  // Proposals move through the pipeline and other admins decide them: follow the board's KB hints.
  const live = useLiveKnowledge(boardId);
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const kb = useQuery({ queryKey: ['kb', boardId], queryFn: () => api.knowledge(boardId) });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const [picked, setPicked] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  usePageContext({ type: 'knowledge', ...(viewing === null ? {} : { id: viewing }) });
  const [comparing, setComparing] = useState<string | null>(null);
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
  const updates = kb.data.catalogUpdates;
  const compared = updates.find((u) => u.name === comparing) ?? null;

  return (
    <main className='mx-auto grid w-full max-w-[63rem] gap-8 p-6' data-live={live}>
      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Documents</h2>
        <p className='text-xs text-muted-foreground'>
          Served to agents through slop's MCP by area. The audience lists the agents that always get a document.
        </p>
        {kb.data.documents.length === 0 && <p className='text-sm text-muted-foreground'>No documents yet.</p>}
        <div className='grid gap-1'>
          {kb.data.documents.map((d) => {
            const update = updates.find((u) => u.name === d.name);
            return (
              <div key={d.name} className='grid gap-0.5 rounded-md border bg-card text-sm'>
                <button type='button' onClick={() => setViewing(d.name)} className='grid gap-0.5 rounded-md p-2 text-left hover:bg-muted'>
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
                {update !== undefined && (
                  <button
                    type='button'
                    onClick={() => setComparing(d.name)}
                    className='mx-2 mb-2 w-fit rounded bg-amber-500/15 px-1.5 text-left text-xs text-amber-800 hover:underline dark:text-amber-200'
                    data-testid={`catalog-update-${d.name}`}
                  >
                    Catalog has a newer version (v{update.catalogVersion})
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {admin && (
          <label className='mt-2 inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted'>
            Upload .md files
            <input type='file' accept='.md' multiple className='hidden' onChange={(e) => void onFiles(e)} />
          </label>
        )}
      </section>

      {/* Keyed by board: another board's proposals (or its history limit) must never show here. */}
      <KbProposals
        key={boardId}
        boardId={boardId}
        admin={admin}
        documents={kb.data.documents}
        agentEntries={kb.data.agentSet.entries}
        onOpenDocument={setViewing}
        live={live}
      />

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
          Written into each checkout by <code>sstor init</code>, and refreshed by routines at the start of a run. Each file is
          slop's catalog version plus this board's rules, so catalog updates arrive on their own.
        </p>
        <AgentSetFiles boardId={boardId} admin={admin} entries={kb.data.agentSet.entries} />
      </section>

      <section className='grid gap-2' data-testid='local-run'>
        <h2 className='text-sm font-semibold'>
          Local-run spec{kb.data.localRun.version === null ? '' : ` · version ${kb.data.localRun.version}`}
        </h2>
        <p className='text-xs text-muted-foreground'>
          What sstor builds and launches in each session's server window, written to <code>.sstor/local-run.json</code> by{' '}
          <code>sstor init</code>. It changes only through an approved proposal (target: Local-run spec).
        </p>
        {kb.data.localRun.problem !== null && <p className='text-xs text-destructive'>{kb.data.localRun.problem}; it isn't served.</p>}
        {kb.data.localRun.content === null ? (
          <p className='text-xs text-muted-foreground'>Not set.</p>
        ) : (
          <pre className='overflow-x-auto rounded border p-2 text-xs'>{kb.data.localRun.content}</pre>
        )}
      </section>

      <section className='grid gap-2' data-testid='merge-policy'>
        <h2 className='text-sm font-semibold'>
          Merge policy{kb.data.mergePolicy.version === null ? '' : ` · version ${kb.data.mergePolicy.version}`}
        </h2>
        <p className='text-xs text-muted-foreground'>
          Which paths only one open glob may change at a time (<code>exclusivePaths</code>: globs that would both change one wait for each other) and which are left out when a sub is sized (<code>sizeIgnoredPaths</code>). It changes only through an approved proposal (target: Merge policy).
        </p>
        {kb.data.mergePolicy.problem !== null && <p className='text-xs text-destructive'>{kb.data.mergePolicy.problem}; it isn't used.</p>}
        {kb.data.mergePolicy.content === null ? (
          <p className='text-xs text-muted-foreground'>Not set.</p>
        ) : (
          <pre className='overflow-x-auto rounded border p-2 text-xs'>{kb.data.mergePolicy.content}</pre>
        )}
      </section>

      {viewing !== null && (
        <Dialog open onOpenChange={(o) => !o && setViewing(null)}>
          <DialogContent title={viewing} className='max-w-3xl'>
            <pre className='overflow-x-auto text-xs whitespace-pre-wrap'>{doc.data?.[0]?.content ?? 'Loading…'}</pre>
          </DialogContent>
        </Dialog>
      )}
      {compared !== null && (
        <Dialog open onOpenChange={(o) => !o && setComparing(null)}>
          <DialogContent title={`${compared.name}: catalog v${compared.catalogVersion}`} className='max-w-3xl'>
            <div className='grid gap-3'>
              <p className='text-xs text-muted-foreground'>
                This board's copy was taken from catalog v{compared.forkedVersion} of {compared.catalogId}. Catalog documents
                stay as the board forked them, so nothing changes here on its own: copy across what you want. Lines only in
                the board's copy are marked −, lines only in the catalog's v{compared.catalogVersion} +.
              </p>
              <LineDiff board={compared.board} catalog={compared.catalog} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
};
