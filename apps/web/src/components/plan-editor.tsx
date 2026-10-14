import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { ArtifactView } from '@/lib/api';
import { copyOrSelect, planBaseline, planText, planVersionLabel, planVersionLine } from '@/lib/plan-text';
import { CollapsibleMarkdown } from '@/components/markdown-view';
import { useToast } from '@/toast';

export type DocKind = 'plan' | 'test_plan';

/** What differs between the documents the editor handles. */
const DOCS = {
  plan: {
    queryKey: 'plan',
    file: 'plan.md',
    noun: 'plan',
    saveLabel: 'Save plan',
    placeholder: 'What to build, and "Done when:" lines…',
    read: (id: string) => api.plan(id),
  },
  test_plan: {
    queryKey: 'test-plan',
    file: 'test-plan.md',
    noun: 'test plan',
    saveLabel: 'Save test plan',
    placeholder: 'A Name | Status | Location | Description table and an atf-specs block…',
    read: (id: string) => api.testPlan(id),
  },
} as const;

/** What a custom preview gets: the text on screen and the saved version it is (null for a draft). */
export interface DocPreviewProps {
  content: string;
  artifact: ArtifactView | null;
  startExpanded: boolean;
}

/** A glob's plan.md or test plan: edit, preview, versions and copy. Every save is a new version. */
export const DocEditor = ({
  globId,
  kind,
  startExpanded = false,
  preview,
  empty,
  template,
}: {
  globId: string;
  kind: DocKind;
  /** A deep link to the section opens the preview expanded. */
  startExpanded?: boolean;
  /** Replaces the markdown preview. */
  preview?: (props: DocPreviewProps) => ReactNode;
  /** Shown in place of the preview while nothing is saved and nothing is being written; `write` starts a draft from `template`. */
  empty?: (write: () => void) => ReactNode;
  /** The draft "Write one" starts from. */
  template?: string;
}) => {
  const doc = DOCS[kind];
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: [doc.queryKey, globId], queryFn: () => doc.read(globId) });
  const current = plan.data?.current ?? null;
  const versionCount = plan.data?.versions.length ?? 0;
  // The version the preview shows: null is the latest. Edit always returns to the latest.
  const [viewed, setViewed] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const past = useQuery({
    queryKey: [`${doc.queryKey}-versions`, globId, current?.version ?? 0],
    queryFn: () => api.artifactVersions(globId, kind, ''),
    enabled: opened && versionCount > 1,
    // A live update bumps the key; the viewed version stays on screen while the list refetches.
    placeholderData: keepPreviousData,
  });
  const viewedVersion = viewed === null || viewed === current?.version ? null : (past.data?.find((v) => v.version === viewed) ?? null);
  const saved = current?.content ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  // The saved content the draft started from: live updates refetch the plan, and a change
  // underneath a draft is flagged rather than allowed to wipe it.
  const [base, setBase] = useState<string | null>(null);
  // Always opens in preview; Edit switches to the editor, Save or Discard returns to preview.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setDraft(null);
    setEditing(false);
    setOpened(false);
    setViewed(null);
  }, [globId]);
  const changedUnderneath = draft !== null && saved !== base;

  const edit = (text: string) => {
    if (draft === null) setBase(saved);
    setDraft(text);
  };

  const save = useMutation({
    // The test plan checks the version it was read at, so a save over a newer one is refused instead of overwriting it.
    mutationFn: (content: string) =>
      kind === 'plan' ? api.savePlan(globId, content) : api.saveTestPlan(globId, content, current?.version ?? 0),
    onSuccess: () => {
      setDraft(null);
      setEditing(false);
      void client.invalidateQueries({ queryKey: [doc.queryKey, globId] });
    },
    onError: (e) => {
      toast(e instanceof RequestError ? e.body.message : `Could not save the ${doc.noun}`);
      // A conflict means the saved text moved: refetch, and the banner below offers Reload or Keep editing.
      if (e instanceof RequestError && e.body.code === 'version_conflict') {
        void client.invalidateQueries({ queryKey: [doc.queryKey, globId] });
      }
    },
  });

  const value = viewedVersion === null ? planText(draft, saved) : viewedVersion.content;
  const area = useRef<HTMLTextAreaElement>(null);
  // The editor grows with its content instead of scrolling inside itself.
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [value, editing]);
  const copy = async () => {
    const ok = await copyOrSelect(value, navigator.clipboard, () => area.current?.select());
    toast(ok ? 'Copied' : 'Could not copy; the text is selected, press Ctrl+C');
  };
  const discard = () => {
    setDraft(null);
    setEditing(false);
  };
  // "Write one": the template is the draft, so Save is offered at once.
  const startWriting = () => {
    setBase(saved);
    setDraft(template ?? '');
    setEditing(true);
  };
  const startEditing = () => {
    setViewed(null);
    setEditing(true);
  };
  const dirty = draft !== null && draft !== planBaseline(saved);
  return (
    <div className='grid gap-2'>
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span className='font-semibold'>{doc.file}</span>
        <span className='flex items-center gap-2'>
          {versionCount > 1 && !editing ? (
            <DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
              <DropdownMenuTrigger className='flex items-center gap-1 hover:text-foreground' data-testid='plan-version'>
                {viewedVersion !== null ? planVersionLabel(viewedVersion) : planVersionLine(current, dirty)}
                <span aria-hidden>▾</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {[...(past.data ?? [])].reverse().map((v) => (
                  <DropdownMenuItem key={v.version} onSelect={() => setViewed(v.version === current?.version ? null : v.version)}>
                    {planVersionLabel(v)}
                    {v.version === current?.version ? ' (latest)' : ''}
                  </DropdownMenuItem>
                ))}
                {past.isError && <span className='px-2 text-red'>Could not load the versions.</span>}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span data-testid='plan-version'>{planVersionLine(current, dirty)}</span>
          )}
          <Button variant='ghost' size='sm' onClick={() => (editing ? discard() : startEditing())}>
            {editing ? 'Preview' : 'Edit'}
          </Button>
          <Button variant='ghost' size='sm' onClick={() => void copy()}>
            Copy
          </Button>
        </span>
      </div>
      {!editing ? (
        empty !== undefined && current === null && draft === null && !plan.isPending ? (
          empty(startWriting)
        ) : (
          <div onDoubleClick={startEditing}>
            {preview === undefined ? (
              <CollapsibleMarkdown content={value} startExpanded={startExpanded} />
            ) : (
              preview({ content: value, artifact: viewedVersion ?? (draft === null ? current : null), startExpanded })
            )}
          </div>
        )
      ) : (
        <Textarea
          ref={area}
          className='min-h-40 resize-none overflow-hidden font-mono text-xs'
          value={value}
          placeholder={doc.placeholder}
          onChange={(e) => edit(e.target.value)}
        />
      )}
      {changedUnderneath && (
        <div className='flex items-center justify-between gap-2 rounded border border-amber/50 bg-amber/10 px-2 py-1 text-xs'>
          <span>{doc.file} changed since you started editing.</span>
          <span className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={() => setDraft(null)}>
              Reload
            </Button>
            <Button variant='ghost' size='sm' onClick={() => setBase(saved)}>
              Keep editing
            </Button>
          </span>
        </div>
      )}
      {dirty && (
        <div className='flex justify-end gap-2'>
          <Button variant='outline' size='sm' onClick={discard}>
            Discard
          </Button>
          <Button size='sm' disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {doc.saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
};

/** plan.md for a glob: what the implementer works from. Every save is a new version. */
export const PlanEditor = ({
  globId,
  startExpanded = false,
}: {
  globId: string;
  /** A deep link to the plan section opens the preview expanded. */
  startExpanded?: boolean;
}) => <DocEditor globId={globId} kind='plan' startExpanded={startExpanded} />;
