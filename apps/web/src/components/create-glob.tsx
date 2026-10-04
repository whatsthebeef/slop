import { CATEGORIES, isValidCombination, SLOP_TYPES } from '@slop/core';
import type { Category, SlopType } from '@slop/core';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { BoardView, NewGlob } from '@/lib/api';

const empty = (): NewGlob => ({
  title: '',
  summary: '',
  type: 'same',
  category: 'task',
  group: null,
  environment: null,
  autoTrigger: false,
});

/**
 * The structured create form. Free-text intake (Process) fills this same form once the LLM
 * port arrives; until then it is filled directly.
 */
export const CreateGlobDialog = ({
  board,
  groups,
  open,
  onOpenChange,
  onCreate,
}: {
  board: BoardView;
  groups: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewGlob) => Promise<void>;
}) => {
  const [form, setForm] = useState<NewGlob>(empty);
  const [request, setRequest] = useState('');
  const [processing, setProcessing] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restricted = board.role === 'qa' || board.role === 'po';
  const types = SLOP_TYPES.filter((t) => !(restricted && t === 'super'));
  const valid = isValidCombination(form.type, form.category) && form.title.trim() !== '';
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);

  /** Intake: the LLM proposes the fields from free text; the person checks them before Create. */
  const processRequest = async () => {
    setProcessing(true);
    setError(null);
    try {
      const proposal = await api.intake(board.id, request);
      setForm({
        title: proposal.title,
        summary: proposal.summary,
        type: restricted && proposal.type === 'super' ? 'same' : proposal.type,
        category: proposal.category,
        group: proposal.group,
        environment: form.environment,
        autoTrigger: proposal.autoTrigger,
      });
      setReason(proposal.autoTriggerReason);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process the request');
    } finally {
      setProcessing(false);
    }
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ ...form, group: form.group?.trim() === '' ? null : form.group });
      setForm(empty());
      setRequest('');
      setReason(null);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the glob');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title='New glob'>
        <div className='mb-4 grid gap-2 border-b pb-4'>
          <Label>
            Describe the work (optional)
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder='Paste a request, notes or a thread; Process fills in the form below.'
            />
          </Label>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='w-fit'
            disabled={request.trim() === '' || processing}
            onClick={() => void processRequest()}
          >
            {processing ? 'Processing…' : 'Process'}
          </Button>
        </div>
        <form className='grid gap-3' onSubmit={(e) => void submit(e)}>
          <Label>
            Title
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          </Label>
          <Label>
            Summary
            <Textarea value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          </Label>
          <div className='grid grid-cols-2 gap-3'>
            <Label>
              Type
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as SlopType })}>
                {types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Label>
            <Label>
              Category
              <Select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} disabled={!isValidCombination(form.type, c)}>
                    {c}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Group
              <Input
                list='groups'
                value={form.group ?? ''}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
              />
              <datalist id='groups'>
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Label>
            <Label>
              Environment
              <Select
                value={form.environment ?? ''}
                onChange={(e) => setForm({ ...form, environment: e.target.value === '' ? null : e.target.value })}
              >
                <option value=''>None</option>
                {deployable.map((env) => (
                  <option key={env.name}>{env.name}</option>
                ))}
              </Select>
            </Label>
          </div>
          {form.type === 'same' && (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={form.autoTrigger}
                onChange={(e) => setForm({ ...form, autoTrigger: e.target.checked })}
              />
              Start a routine run straight away
            </label>
          )}
          {form.type === 'same' && form.autoTrigger && reason !== null && (
            <p className='text-xs text-muted-foreground'>{reason}</p>
          )}
          {!isValidCombination(form.type, form.category) && (
            <p className='text-xs text-red'>
              A {form.category} cannot be a {form.type}.
            </p>
          )}
          {error !== null && <p className='text-sm text-red'>{error}</p>}
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={!valid || busy}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
