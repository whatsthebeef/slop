import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { GlobView, SplitPartInput } from '@/lib/api';
import { GroupInput } from '@/components/group-input';
import { planText } from '@/lib/plan-text';
import { groupFromTitle } from '@slop/core';
import type { SlopType } from '@slop/core';

interface Draft {
  title: string;
  plan: string;
  type: SlopType;
  /** Indexes of earlier parts, as chosen in the "waits for" picker; none runs in parallel. */
  after: number[];
}

/** Can a glob be split: in Planning, not started, no run and no PR. */
export const canSplit = (glob: GlobView): boolean =>
  glob.status === 'planning' && glob.provisioning === 'none' && glob.runs.length === 0 && glob.pr === null && glob.type !== null && glob.type !== 'super';

/**
 * A manual scope cut: a glob in Planning becomes independent globs. Part 1 stays this glob with its plan to edit down; the
 * others are new globs in its group. Each part ships on its own; a part only waits for another when picked in "Starts after".
 * `{part:2}` in a plan stands for that part's glob ID.
 */
export const SplitGlob = ({
  glob,
  groups = [],
  onDone,
  onCancel,
}: {
  glob: GlobView;
  /** The board's existing groups, to suggest when the glob has none. */
  groups?: readonly string[];
  onDone: (parts: GlobView[]) => void;
  onCancel: () => void;
}) => {
  const plan = useQuery({ queryKey: ['plan', glob.id], queryFn: () => api.plan(glob.id) });
  const original = planText(null, plan.data?.current?.content ?? null);
  const [parts, setParts] = useState<Draft[] | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  // A glob without a group asks for one, prefilled from its title; the parts and the original all join it.
  const [group, setGroup] = useState(() => (glob.group === null ? (groupFromTitle(glob.title, groups) ?? '') : ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (plan.isPending) return <p className='text-xs text-muted-foreground'>Loading plan.md…</p>;
  const shown: Draft[] = parts ?? [
    { title: glob.title, plan: original, type: glob.type ?? 'same', after: [] },
    { title: '', plan: '', type: glob.type ?? 'same', after: [0] },
  ];
  const edit = (index: number, changes: Partial<Draft>) => setParts(shown.map((p, i) => (i === index ? { ...p, ...changes } : p)));
  const remove = (index: number) =>
    setParts(
      shown
        .filter((_, i) => i !== index)
        .map((p) => ({ ...p, after: p.after.filter((n) => n !== index).map((n) => (n > index ? n - 1 : n)) })),
    );
  const ready = (glob.group !== null || group.trim() !== '') && shown.length >= 2 && shown.every((p) => p.title.trim() !== '' && p.plan.trim() !== '');
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: SplitPartInput[] = shown.map((p, index) => ({
        title: p.title,
        plan: p.plan,
        ...(index > 0 && p.type !== glob.type ? { type: p.type } : {}),
        ...(index > 0 && p.after.length > 0 ? { after: p.after } : {}),
      }));
      const result = await api.splitGlob(glob.id, glob.version, body, key, glob.group === null ? group.trim() : undefined);
      onDone(result.parts);
    } catch (e) {
      setError(e instanceof RequestError ? e.body.message : 'Could not split the glob');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='grid gap-3 rounded border p-3' data-testid='split-editor'>
      <p className='text-xs text-muted-foreground'>
        Part 1 stays {glob.id}. Cut its plan between the parts; each piece ships on its own, so give each its own title and share of
        the plan. Pick "Starts after" only when a part needs another's code; write {'{part:2}'} to name another part's glob ID.
      </p>
      {glob.group === null ? (
        <Label>
          Group (every part, including {glob.id}, joins it)
          <GroupInput groups={groups} value={group} data-testid='split-group' onChange={(e) => setGroup(e.target.value)} />
        </Label>
      ) : (
        <p className='text-xs text-muted-foreground'>
          Every part stays in the group <span className='font-mono'>{glob.group}</span>.
        </p>
      )}
      {shown.map((part, index) => (
        <div key={index} className='grid gap-2 rounded border p-2' data-testid={`split-part-${index + 1}`}>
          <div className='flex items-center justify-between text-xs font-semibold'>
            <span>{index === 0 ? `Part 1 (${glob.id})` : `Part ${index + 1}`}</span>
            {index > 1 && (
              <Button size='sm' variant='ghost' onClick={() => remove(index)}>
                Remove
              </Button>
            )}
          </div>
          <Label>
            Title
            <Input value={part.title} placeholder="Task: what this part delivers" onChange={(e) => edit(index, { title: e.target.value })} />
          </Label>
          <Label>
            Plan
            <Textarea rows={6} value={part.plan} onChange={(e) => edit(index, { plan: e.target.value })} />
          </Label>
          {index > 0 && (
            <div className='flex flex-wrap items-center gap-3 text-xs'>
              <Label>
                Type
                <Select value={part.type} onChange={(e) => edit(index, { type: e.target.value === 'sub' ? 'sub' : 'same' })}>
                  <option value='same'>same</option>
                  <option value='sub'>sub</option>
                </Select>
              </Label>
              <span>Starts after:</span>
              {shown.slice(0, index).map((_, n) => (
                <label key={n} className='flex items-center gap-1'>
                  <input
                    type='checkbox'
                    checked={part.after.includes(n)}
                    onChange={(e) => edit(index, { after: e.target.checked ? [...part.after, n].sort() : part.after.filter((x) => x !== n) })}
                  />
                  part {n + 1}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className='flex flex-wrap items-center gap-2'>
        {shown.length < 10 && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => setParts([...shown, { title: '', plan: '', type: glob.type ?? 'same', after: [shown.length - 1] }])}
          >
            Add a part
          </Button>
        )}
        <span className='flex-1' />
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Cancel
        </Button>
        <Button size='sm' disabled={busy || !ready} data-testid='confirm-split' onClick={() => void submit()}>
          Split into {shown.length} independent globs
        </Button>
      </div>
      {error !== null && (
        <p role='alert' className='text-xs text-red' data-testid='split-failure'>
          {error}
        </p>
      )}
    </div>
  );
};
