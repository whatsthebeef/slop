import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { copyOrSelect, planBaseline, planText, planVersionLine } from '@/lib/plan-text';
import { MarkdownView } from '@/components/markdown-view';
import { useToast } from '@/toast';

/** plan.md for a glob: what the implementer works from. Every save is a new version. */
export const PlanEditor = ({ globId, onHistory }: { globId: string; onHistory?: () => void }) => {
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['plan', globId], queryFn: () => api.plan(globId) });
  const current = plan.data?.current ?? null;
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
          {onHistory !== undefined && current !== null && (
            <Button variant='ghost' size='sm' onClick={onHistory} data-testid='plan-history'>
              v{current.version} · history
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
          <MarkdownView content={value} />
        </div>
      ) : (
        <Textarea
          ref={area}
          className='min-h-40 font-mono text-xs'
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
