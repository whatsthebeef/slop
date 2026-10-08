import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { copyOrSelect, planBaseline, planText } from '@/lib/plan-text';
import { useToast } from '@/toast';

/** plan.md for a glob: what the implementer works from. Every save is a new version. */
export const PlanEditor = ({ globId, summary }: { globId: string; summary: string }) => {
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['plan', globId], queryFn: () => api.plan(globId) });
  const saved = plan.data?.current?.content ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  // The saved content the draft started from: live updates refetch the plan, and a change
  // underneath a draft is flagged rather than allowed to wipe it.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => setDraft(null), [globId]);
  const changedUnderneath = draft !== null && saved !== base;

  const edit = (text: string) => {
    if (draft === null) setBase(saved);
    setDraft(text);
  };

  const save = useMutation({
    mutationFn: (content: string) => api.savePlan(globId, content),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ['plan', globId] });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save the plan'),
  });

  const value = planText(draft, saved, summary);
  const area = useRef<HTMLTextAreaElement>(null);
  const copy = async () => {
    const ok = await copyOrSelect(value, navigator.clipboard, () => area.current?.select());
    toast(ok ? 'Copied' : 'Could not copy; the text is selected, press Ctrl+C');
  };
  const versions = plan.data?.versions.length ?? 0;
  return (
    <div className='grid gap-2'>
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span className='font-semibold'>plan.md</span>
        <span className='flex items-center gap-2'>
          <span>{versions === 0 ? 'not written yet' : `version ${versions}`}</span>
          <Button variant='ghost' size='sm' onClick={() => void copy()}>
            Copy
          </Button>
        </span>
      </div>
      <Textarea
        ref={area}
        className='min-h-40 font-mono text-xs'
        value={value}
        placeholder='What to build, and "Done when:" lines…'
        onChange={(e) => edit(e.target.value)}
      />
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
      {draft !== null && draft !== planBaseline(saved, summary) && (
        <div className='flex justify-end gap-2'>
          <Button variant='outline' size='sm' onClick={() => setDraft(null)}>
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
