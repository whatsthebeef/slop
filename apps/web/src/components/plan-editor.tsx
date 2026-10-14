import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { copyOrSelect, planBaseline, planText, planVersionLine } from '@/lib/plan-text';
import { CollapsibleMarkdown } from '@/components/markdown-view';
import { useToast } from '@/toast';

/** plan.md for a glob: what the implementer works from. Every save is a new version. */
export const PlanEditor = ({
  globId,
  history = true,
  startExpanded = false,
}: {
  globId: string;
  /** Offers the plan's earlier versions inline; false when another section already lists them. */
  history?: boolean;
  /** A deep link to the plan section opens the preview expanded. */
  startExpanded?: boolean;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['plan', globId], queryFn: () => api.plan(globId) });
  const current = plan.data?.current ?? null;
  const versionCount = plan.data?.versions.length ?? 0;
  const [showHistory, setShowHistory] = useState(false);
  const [viewed, setViewed] = useState<number | null>(null);
  const past = useQuery({
    queryKey: ['plan-versions', globId, current?.version ?? 0],
    queryFn: () => api.artifactVersions(globId, 'plan', ''),
    enabled: history && showHistory && versionCount > 1,
  });
  const viewedVersion = past.data?.find((v) => v.version === viewed) ?? null;
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
    setShowHistory(false);
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

  const value = planText(draft, saved);
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
  const dirty = draft !== null && draft !== planBaseline(saved);
  return (
    <div className='grid gap-2'>
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span className='font-semibold'>plan.md</span>
        <span className='flex items-center gap-2'>
          <span data-testid='plan-version'>{planVersionLine(current, dirty)}</span>
          {history && versionCount > 1 && (
            <Button
              variant='ghost'
              size='sm'
              aria-expanded={showHistory}
              onClick={() => setShowHistory((open) => !open)}
              data-testid='plan-history'
            >
              History
            </Button>
          )}
          <Button variant='ghost' size='sm' onClick={() => (editing ? discard() : setEditing(true))}>
            {editing ? 'Preview' : 'Edit'}
          </Button>
          <Button variant='ghost' size='sm' onClick={() => void copy()}>
            Copy
          </Button>
        </span>
      </div>
      {!editing ? (
        <div onDoubleClick={() => setEditing(true)}>
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
      {history && showHistory && versionCount > 1 && (
        <div className='grid gap-2 rounded border p-2 text-xs' data-testid='plan-versions'>
          <div className='flex flex-wrap gap-1'>
            {[...(past.data ?? [])].reverse().map((v) => (
              <Button
                key={v.version}
                variant={v.version === viewed ? 'outline' : 'ghost'}
                size='sm'
                onClick={() => setViewed(v.version === viewed ? null : v.version)}
              >
                v{v.version} · {v.createdAt.slice(0, 16).replace('T', ' ')}
              </Button>
            ))}
            {past.isError && <span className='text-red'>Could not load the versions.</span>}
          </div>
          {viewedVersion !== null && <CollapsibleMarkdown content={viewedVersion.content} startExpanded />}
        </div>
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
