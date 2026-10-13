import { parseInvestigation } from '@slop/core';
import type { ArtifactKind, Investigation } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, FileCheck, FileText, Microscope, Paperclip, Plus, SearchCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, RequestError } from '@/lib/api';
import type { ArtifactSummaryView, ArtifactView } from '@/lib/api';
import { fileStatus, hasThumbnail } from '@/lib/attachment';
import { inboxLinkTarget, isInboxLink } from '@/lib/inbox';
import { artifactKey, globsKey, inboxKey } from '@/lib/live';
import { listedArtifacts } from '@/lib/plan-text';
import { attachFile, checkFile, FILE_ACCEPT } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';
import { Button } from './ui/button';
import { FileDropZone, UploadRows } from './file-drop';
import type { UploadRow } from './file-drop';
import { MarkdownView } from './markdown-view';

export const ARTIFACT_META: Record<
  ArtifactKind,
  { readonly title: string; readonly icon: LucideIcon }
> = {
  plan: { title: 'plan.md', icon: FileText },
  implementation_plan: { title: 'Implementation record', icon: FileCheck },
  // Legacy rows only: postplans were migrated into the record and writes to the kind land there.
  postplan: { title: 'Postplan (old)', icon: FileCheck },
  local_review: { title: 'Local review', icon: ClipboardCheck },
  independent_review: { title: 'Independent review', icon: SearchCheck },
  investigation: { title: 'Investigation', icon: Microscope },
  assessment: { title: 'Assessment', icon: ClipboardCheck },
  // A KB learning's pipeline output (JSON), shown by the decision section rather than as files.
  draft: { title: 'Draft', icon: FileText },
  outcome: { title: 'Outcome', icon: FileCheck },
  effect_check: { title: 'Effect check', icon: SearchCheck },
  attachment: { title: 'Attachment', icon: Paperclip },
};

/** The kinds shown as icons on a card, in this order. */
export const CARD_ARTIFACT_KINDS = [
  'plan',
  'implementation_plan',
  'local_review',
  'assessment',
  'independent_review',
] as const;

export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly label: string;
}

const titleOf = (a: ArtifactRef) =>
  a.kind === 'attachment' ? a.label : ARTIFACT_META[a.kind].title;
const when = (iso: string) => new Date(iso).toLocaleString();
const shortSha = (sha: string) => sha.slice(0, 7);

/** The glob view's artifact list; selecting one shows its content with its version history. */
export const ArtifactsSection = ({
  globId,
  boardId,
  artifacts,
  signedOff,
  selected,
  onSelect,
}: {
  globId: string;
  boardId: number;
  artifacts: readonly ArtifactSummaryView[];
  signedOff: boolean;
  selected: ArtifactRef | null;
  onSelect: (artifact: ArtifactRef | null) => void;
}) => {
  const [adding, setAdding] = useState(false);
  const listed = listedArtifacts(artifacts, signedOff);
  // plan.md can still be opened from the plan field's history link while it is not listed.
  const current =
    selected === null
      ? undefined
      : artifacts.find((a) => a.kind === selected.kind && a.label === selected.label);
  if (listed.length === 0 && current === undefined) return null;
  return (
    <div className="grid gap-2" data-testid="artifacts">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Artifacts</h3>
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" onClick={() => setAdding(!adding)} data-testid="add-attachment">
          <Plus className="h-3.5 w-3.5" />
          Add attachment
        </Button>
      </div>
      {adding && (
        <AddAttachmentPanel
          globId={globId}
          boardId={boardId}
          onClose={() => setAdding(false)}
          onAdded={(label) => {
            setAdding(false);
            onSelect({ kind: 'attachment', label });
          }}
        />
      )}
      <div className="flex flex-wrap gap-1.5">
        {listed.map((a) => {
          const Icon = ARTIFACT_META[a.kind].icon;
          const active = current === a;
          return (
            <button
              key={`${a.kind}:${a.label}`}
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted',
                active && 'border-foreground bg-muted',
              )}
              aria-pressed={active}
              onClick={() => onSelect(active ? null : { kind: a.kind, label: a.label })}
              data-testid={`artifact-${a.kind}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {titleOf(a)}
              <span className="text-muted-foreground">v{a.version}</span>
            </button>
          );
        })}
      </div>
      {listed
        .filter((a) => a.kind === 'attachment')
        .map((a) => (
          <FileNote key={a.label} globId={globId} boardId={boardId} summary={a} />
        ))}
      {current !== undefined && <ArtifactViewer globId={globId} boardId={boardId} summary={current} />}
    </div>
  );
};

/** Uploads files to a glob, one row each with its progress; slop sees each file arrive on its own. */
const useGlobUploads = (globId: string, boardId: number, onUploaded?: (label: string) => void) => {
  const client = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const next = useRef(0);
  const patch = (id: number, change: Partial<UploadRow>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change } : r)));

  const refresh = (label: string) => {
    void client.invalidateQueries({ queryKey: globsKey(boardId) });
    void client.invalidateQueries({ queryKey: artifactKey(globId, 'attachment', label) });
  };

  const add = (files: readonly File[], label?: string) => {
    for (const file of files) {
      next.current += 1;
      const id = next.current;
      setRows((all) => [...all, { id, name: file.name, progress: 0, error: null, done: false }]);
      attachFile(globId, file, { ...(label === undefined ? {} : { label }), onProgress: (progress) => patch(id, { progress }) })
        .then((outcome) => {
          patch(id, { progress: 1, done: true });
          refresh(outcome.label);
          toast(`${file.name} uploaded`);
          onUploaded?.(outcome.label);
          setTimeout(() => setRows((all) => all.filter((r) => r.id !== id)), 4000);
        })
        .catch((e: unknown) => {
          // The link may already have made a pending entry; it shows in the list as waiting, then as missing.
          refresh(label ?? file.name);
          patch(id, { error: e instanceof Error ? e.message : 'The upload failed' });
        });
    }
  };
  return { rows, add, dismiss: (id: number) => setRows((all) => all.filter((r) => r.id !== id)) };
};

/** The panel behind "Add attachment": pick, drop or paste files; each uploads straight to storage with a progress bar. */
const AddAttachmentPanel = ({
  globId,
  boardId,
  onClose,
  onAdded,
}: {
  globId: string;
  boardId: number;
  onClose: () => void;
  onAdded: (label: string) => void;
}) => {
  const uploads = useGlobUploads(globId, boardId, onAdded);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className='grid gap-2 rounded border p-3 text-xs' data-testid='add-attachment-form'>
      <FileDropZone
        onFiles={(files) => {
          const problems = files.flatMap((f) => {
            const problem = checkFile(f);
            return problem === null ? [] : [problem];
          });
          setError(problems.length === 0 ? null : problems.join('. '));
          uploads.add(files.filter((f) => checkFile(f) === null));
        }}
      />
      {error !== null && (
        <p className='text-destructive' role='alert'>
          {error}
        </p>
      )}
      <UploadRows rows={uploads.rows} onDismiss={uploads.dismiss} />
      <div>
        <Button size='sm' variant='ghost' onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
};

/** What a file attachment is doing: waiting for its upload, or never arrived (with the note and an Upload button). */
const FileNote = ({ globId, boardId, summary }: { globId: string; boardId: number; summary: ArtifactSummaryView }) => {
  const versions = useQuery({
    queryKey: artifactKey(globId, summary.kind, summary.label),
    queryFn: () => api.artifactVersions(globId, summary.kind, summary.label),
    // A pending file turns stored (or missing) without anyone touching the page.
    refetchInterval: (query) => (query.state.data?.at(-1)?.file?.state === 'pending' ? 5000 : false),
  });
  const latest = versions.data?.at(-1);
  const status = latest === undefined ? null : fileStatus(latest);
  if (latest === undefined || status === null || latest.file?.state === 'stored') return null;
  return (
    <p className='flex flex-wrap items-center gap-2 text-xs' data-testid={status.missing ? 'file-missing' : 'file-pending'}>
      <span className={cn(status.missing ? 'text-destructive' : 'text-muted-foreground')}>{status.text}</span>
      {status.missing && <UploadForEntry globId={globId} boardId={boardId} label={summary.label} />}
    </p>
  );
};

/** The Upload button on a missing file: it fills the same entry. */
const UploadForEntry = ({ globId, boardId, label }: { globId: string; boardId: number; label: string }) => {
  const uploads = useGlobUploads(globId, boardId);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button size='sm' variant='outline' onClick={() => input.current?.click()}>
        Upload
      </Button>
      <input
        ref={input}
        type='file'
        hidden
        accept={FILE_ACCEPT}
        aria-label={`Upload ${label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file === undefined) return;
          const problem = checkFile(file);
          setError(problem);
          if (problem === null) uploads.add([file], label);
        }}
      />
      {error !== null && (
        <span className='text-destructive' role='alert'>
          {error}
        </span>
      )}
      <UploadRows rows={uploads.rows} onDismiss={uploads.dismiss} />
    </>
  );
};

/** A stored file in the viewer: an image shows as a thumbnail that opens full size; anything else opens or downloads in a new tab. */
const StoredFile = ({ globId, boardId, view }: { globId: string; boardId: number; view: ArtifactView }) => {
  const client = useQueryClient();
  const toast = useToast();
  const file = view.file;
  const link = useQuery({
    queryKey: ['file-link', globId, view.label, view.version],
    queryFn: () => api.fileDownload(globId, view.label),
    enabled: file?.state === 'stored',
    // The link lasts ~15 minutes; ask again before it can run out.
    staleTime: 10 * 60 * 1000,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteFile(globId, view.label),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: globsKey(boardId) });
      void client.invalidateQueries({ queryKey: artifactKey(globId, 'attachment', view.label) });
      toast('File removed');
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Something went wrong'),
  });
  if (file === null || file === undefined) return null;
  const status = fileStatus(view);
  return (
    <div className='grid gap-2' data-testid='file-attachment'>
      {file.state === 'stored' && link.data !== undefined && (
        <a href={link.data.url} target='_blank' rel='noreferrer' className='w-fit text-sm underline'>
          {hasThumbnail(file) ? (
            <img
              src={link.data.url}
              alt={file.fileName}
              className='max-h-48 max-w-full rounded border object-contain'
              data-testid='file-thumbnail'
            />
          ) : (
            `Open ${file.fileName}`
          )}
        </a>
      )}
      {file.state === 'stored' && link.isError && <p className='text-sm text-red'>Could not get a link to this file.</p>}
      {status !== null && <p className={cn('text-xs', status.missing ? 'text-destructive' : 'text-muted-foreground')}>{status.text}</p>}
      {file.state === 'missing' && (
        <div className='flex flex-wrap items-center gap-2'>
          <UploadForEntry globId={globId} boardId={boardId} label={view.label} />
        </div>
      )}
      <Button
        size='sm'
        variant='outline'
        className='w-fit'
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`Remove ${file.fileName} from ${globId}? The file is deleted.`)) remove.mutate();
        }}
      >
        Remove
      </Button>
    </div>
  );
};

/** Detach for the "From the inbox" attachment: confirms, then removes the item from this glob. */
const DetachInboxItem = ({ globId, link, label }: { globId: string; link: string; label: string }) => {
  const client = useQueryClient();
  const toast = useToast();
  const target = inboxLinkTarget(link);
  const detach = useMutation({
    mutationFn: () => {
      if (target === null) throw new Error('Not an inbox link');
      return api.detachInbox(target.boardId, target.itemId, [globId]);
    },
    onSuccess: () => {
      if (target !== null) void client.invalidateQueries({ queryKey: inboxKey(target.boardId) });
      void client.invalidateQueries({ queryKey: globsKey(target?.boardId ?? 0) });
      toast('Detached');
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Something went wrong'),
  });
  if (target === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-fit"
      disabled={detach.isPending}
      onClick={() => {
        if (window.confirm(`Detach "${label.replace(/^From the inbox: /, '')}" from ${globId}? It leaves this glob's context and choices.`))
          detach.mutate();
      }}
    >
      Detach
    </Button>
  );
};

const ArtifactViewer = ({ globId, boardId, summary }: { globId: string; boardId: number; summary: ArtifactSummaryView }) => {
  const versions = useQuery({
    queryKey: artifactKey(globId, summary.kind, summary.label),
    queryFn: () => api.artifactVersions(globId, summary.kind, summary.label),
  });
  // null follows the latest version as new ones arrive.
  const [pinned, setPinned] = useState<number | null>(null);
  useEffect(() => setPinned(null), [globId, summary.kind, summary.label]);

  const list = versions.data ?? [];
  const shown = (pinned === null ? list.at(-1) : list.find((v) => v.version === pinned)) ?? null;
  return (
    <div className="grid gap-2 rounded border p-3" data-testid="artifact-viewer">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{titleOf(summary)}</span>
        {list.length > 1 && (
          <select
            className="rounded border bg-background px-1 py-0.5"
            aria-label="Version"
            value={shown?.version ?? ''}
            onChange={(e) => {
              const version = Number(e.target.value);
              setPinned(version === list.at(-1)?.version ? null : version);
            }}
          >
            {[...list].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {when(v.createdAt)}
              </option>
            ))}
          </select>
        )}
        {shown !== null && (
          <span>
            {list.length <= 1 && `v${shown.version} · `}
            {shown.commitSha !== null && (
              <>
                commit <span className="font-mono">{shortSha(shown.commitSha)}</span> ·{' '}
              </>
            )}
            {shown.provenance.by} · {shown.provenance.actor}
            {list.length <= 1 && ` · ${when(shown.createdAt)}`}
          </span>
        )}
      </div>
      {versions.isError ? (
        <p className="text-sm text-red">Could not load this artifact.</p>
      ) : shown === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {shown.link !== null &&
            // A link into slop (an inbox item) opens in place; anything else in a new tab.
            (isInboxLink(shown.link) ? (
              <div className="flex flex-wrap items-center gap-3">
                <Link className="text-sm underline" to={shown.link}>
                  Open in the inbox
                </Link>
                <DetachInboxItem globId={globId} link={shown.link} label={shown.label} />
              </div>
            ) : (
              <a className="text-sm underline" href={shown.link} target="_blank" rel="noreferrer">
                {shown.link}
              </a>
            ))}
          {shown.kind === 'investigation' && (
            <InvestigationFields content={shown.content} validation={shown.provenance.validation} />
          )}
          {shown.file === null || shown.file === undefined ? (
            <MarkdownView content={shown.content} />
          ) : (
            <StoredFile globId={globId} boardId={boardId} view={shown} />
          )}
        </>
      )}
    </div>
  );
};

/** The investigation's parsed block as a summary, or the validation note when it could not be read. */
const InvestigationFields = ({ content, validation }: { content: string; validation: string | undefined }) => {
  const parsed = parseInvestigation(content);
  if (!parsed.ok) {
    return (
      <p className="text-sm text-red" data-testid="investigation-invalid">
        {validation ?? parsed.errors.join('; ')}
      </p>
    );
  }
  const i: Investigation = parsed.investigation;
  const rows: [string, string][] = [
    ['Risk', `${i.riskTier}${i.riskAreas.length > 0 ? ` (${i.riskAreas.join(', ')})` : ''}`],
    ['Needs a human', i.needsHuman.needed ? `yes: ${i.needsHuman.reason ?? ''}` : 'no'],
    ['Confidence', i.confidence],
    ['Expected lines', `${String(i.expectedLines.min)}–${String(i.expectedLines.max)}`],
    ['Modules', i.modules.join(', ') || 'none'],
    ['Files', i.files.map((f) => `${f.change} ${f.path}`).join('\n') || 'none'],
    [
      'Parts',
      i.parts.map((p) => `${p.name} (${String(p.files.length)} files${p.needs.length > 0 ? `, needs ${p.needs.join(', ')}` : ''})`).join('\n') ||
        'one',
    ],
    ['Made against', `plan ${i.planHash.slice(0, 8)} · base ${i.baseCommit.slice(0, 7)}`],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="investigation-fields">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
};
