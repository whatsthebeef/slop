import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { copyOrSelect, planBaseline, planText, planVersionLabel, planVersionLine } from '@/lib/plan-text';
import { CollapsibleMarkdown } from '@/components/markdown-view';
import { useToast } from '@/toast';

/** plan.md for a glob: what the implementer works from. Every save is a new version. */
export const PlanEditor = ({
  globId,
  startExpanded = false,
}: {
  globId: string;
  /** A deep link to the plan section opens the preview expanded. */
  startExpanded?: boolean;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['plan', globId], queryFn: () => api.plan(globId) });
  const current = plan.data?.current ?? null;
  const versionCount = plan.data?.versions.length ?? 0;
  // The version the preview shows: null is the latest. Edit always returns to the latest.
  const [viewed, setViewed] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const past = useQuery({
    queryKey: ['plan-versions', globId, current?.version ?? 0],
    queryFn: () => api.artifactVersions(globId, 'plan', ''),
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
    mutationFn: (content: string) => api.savePlan(globId, content),
    onSuccess: () => {
      setDraft(null);
      setEditing(false);
      void client.invalidateQueries({ queryKey: ['plan', globId] });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save the plan'),
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
  const startEditing = () => {
    setViewed(null);
    setEditing(true);
  };
  const dirty = draft !== null && draft !== planBaseline(saved);
  return (
    <div className='grid gap-2'>
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span className='font-semibold'>plan.md</span>
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
        <div onDoubleClick={startEditing}>
          <CollapsibleMarkdown content={value} startExpanded={startExpanded} />
        </div>
      ) : (
        <Textarea
          ref={area}
          className='min-h-40 resize-none overflow-hidden font-mono text-xs'
          value={value}
          placeholder='What to build, and "Done when:" lines…'
          onChange={(e) => edit(e.target.value)}
        />
      )}
      {changedUnderneath && (
        <div className='flex items-center justify-between gap-2 rounded border border-amber/50 bg-amber/10 px-2 py-1 text-xs'>
          <span>plan.md changed since you started editing.</span>
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
            Save plan
          </Button>
        </div>
      )}
    </div>
  );
};
