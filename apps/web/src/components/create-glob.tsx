import { canChooseType, isValidCombination, SLOP_TYPES, WORK_CATEGORIES } from '@slop/core';
import type { Category, SlopType } from '@slop/core';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import { globsKey } from '@/lib/live';
import { CHOOSE_TYPE_TOOLTIP } from '@/lib/type-change';
import { attachFile, checkFile } from '@/lib/upload';
import { useToast } from '@/toast';
import { FileDropZone } from './file-drop';
import { GroupInput } from './group-input';
import type { BoardView, IntakeProposalView, NewGlob } from '@/lib/api';

const empty = (): NewGlob => ({
  title: '',
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
  initialRequest = '',
  fromInbox,
  onOpenChange,
  onCreate,
}: {
  board: BoardView;
  groups: readonly string[];
  open: boolean;
  /** Free text to start the request box with (a chat answer); Process turns it into the fields. */
  initialRequest?: string;
  /** The inbox item the glob is made from: it is attached on create, under this creation key. */
  fromInbox?: { id: number; title: string; key: string };
  onOpenChange: (open: boolean) => void;
  /** Creates the glob; the files staged in the dialog are uploaded to the glob it returns. */
  onCreate: (input: NewGlob) => Promise<{ id: string } | undefined>;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const [staged, setStaged] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [form, setForm] = useState<NewGlob>(empty);
  const [request, setRequest] = useState(initialRequest);
  // A new text from outside (another chat answer) replaces what was typed.
  const [seen, setSeen] = useState(initialRequest);
  if (seen !== initialRequest) {
    setSeen(initialRequest);
    setRequest(initialRequest);
  }
  const [processing, setProcessing] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  // What the last Process said about its category: how sure it was and the past globs it was shown.
  const [insight, setInsight] = useState<IntakeProposalView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restricted = board.role === 'qa' || board.role === 'po';
  const types = SLOP_TYPES.filter((t) => !(restricted && t === 'super'));
  const chooses = (t: SlopType) => canChooseType(board.role, t);
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
        plan: proposal.plan,
        type: chooses(proposal.type) ? proposal.type : 'same',
        category: proposal.category,
        group: proposal.group,
        // An environment the person already chose wins over one the request names.
        environment: form.environment ?? proposal.environment,
        autoTrigger: proposal.autoTrigger,
        // A super intake chose waits in Planning for a person to pick it up.
        ...(chooses(proposal.type) && proposal.type === 'super' ? { start: false } : {}),
        ...(proposal.files === undefined || proposal.files.length === 0 ? {} : { files: proposal.files }),
      });
      setReason(proposal.autoTriggerReason);
      setInsight(proposal);
      setConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process the request');
    } finally {
      setProcessing(false);
    }
  };

  const uploadStaged = (globId: string, files: readonly File[]) => {
    void Promise.allSettled(files.map((file) => attachFile(globId, file).then(() => toast(`${file.name} uploaded to ${globId}`)))).then((results) => {
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${files[i]?.name ?? 'A file'}: ${r.reason instanceof Error ? r.reason.message : 'failed'}`] : []));
      if (failed.length > 0) toast(`${globId}: ${failed.join('; ')}. Upload it from the glob view.`, 10000);
      void client.invalidateQueries({ queryKey: globsKey(board.id) });
    });
  };

  const stage = (files: File[]) => {
    const problems = files.flatMap((f) => {
      const problem = checkFile(f);
      return problem === null ? [] : [problem];
    });
    setFileError(problems.length === 0 ? null : problems.join('. '));
    setStaged((all) => [...all, ...files.filter((f) => checkFile(f) === null)]);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({
        ...form,
        ...(fromInbox === undefined ? {} : { inboxItem: fromInbox.id, idempotencyKey: fromInbox.key }),
        // A blank group after intake means none; typed by hand with no request, it is left for slop to choose.
        ...((form.group ?? '').trim() === '' ? (insight === null ? { group: undefined } : { group: null }) : { group: form.group ?? null }),
        ...(insight === null
          ? {}
          : {
              intake: {
                request,
                categoryConfidence: insight.categoryConfidence,
                reason: insight.categoryReason,
                model: insight.model,
                promptVersion: insight.promptVersion,
                examples: insight.examples.map((e) => e.globId),
              },
            }),
      });
      // The glob exists now: its files go up in the background. One that fails stays on the glob as a
      // "never uploaded" note, and a person can upload it from the glob view.
      if (created !== undefined && staged.length > 0) uploadStaged(created.id, staged);
      setStaged([]);
      setFileError(null);
      setForm(empty());
      setRequest('');
      setReason(null);
      setInsight(null);
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
        {fromInbox !== undefined && (
          <p className='mb-3 text-xs text-muted-foreground' data-testid='from-inbox'>
            From the inbox: {fromInbox.title}. The item will be attached.
          </p>
        )}
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
            Plan
            <Textarea value={form.plan ?? ''} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
          </Label>
          <div className='grid grid-cols-2 gap-3'>
            <Label>
              Type
              <Select
                value={form.type}
                title={types.some((t) => !chooses(t)) ? CHOOSE_TYPE_TOOLTIP : undefined}
                onChange={(e) => setForm({ ...form, type: e.target.value as SlopType })}
              >
                {types.map((t) => (
                  <option key={t} disabled={!chooses(t)} title={chooses(t) ? undefined : CHOOSE_TYPE_TOOLTIP}>
                    {t}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Category
              <Select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
              >
                {WORK_CATEGORIES.map((c) => (
                  <option key={c} disabled={!isValidCombination(form.type, c)}>
                    {c}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Group
              <GroupInput
                groups={groups}
                value={form.group ?? ''}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
              />
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
          {insight !== null && insight.needsConfirmation && !confirmed && (
            <div className='grid gap-1 rounded border border-amber/60 bg-amber/10 p-2 text-xs' data-testid='intake-unsure'>
              <p>
                Intake is not sure about the category ({insight.category}
                {insight.categoryReason === null ? '' : `: ${insight.categoryReason}`}). Check it, then confirm.
              </p>
              <Button type='button' variant='outline' size='sm' className='w-fit' onClick={() => setConfirmed(true)}>
                Category is right
              </Button>
            </div>
          )}
          {insight !== null && insight.typeReason != null && (
            <p className='text-xs text-muted-foreground' data-testid='intake-type-reason'>
              Type {insight.type}: {insight.typeReason}
            </p>
          )}
          {insight !== null && insight.examples.length > 0 && (
            <p className='text-xs text-muted-foreground' data-testid='intake-examples'>
              Based on similar globs:{' '}
              {insight.examples
                .map((e) => `${e.globId} (${e.type} ${e.category}${e.note === null ? '' : `, ${e.note}`})`)
                .join('; ')}
            </p>
          )}
          {form.type === 'super' && (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={form.start === false}
                onChange={(e) => setForm({ ...form, ...(e.target.checked ? { start: false } : { start: true }) })}
              />
              Park in Planning until someone picks it up to pair
            </label>
          )}
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
          <div className='grid gap-1.5' data-testid='create-files'>
            <FileDropZone onFiles={stage} disabled={busy} hint='They upload to the glob once it is created.' />
            {fileError !== null && (
              <p className='text-xs text-destructive' role='alert'>
                {fileError}
              </p>
            )}
            {staged.length > 0 && (
              <ul className='grid gap-0.5 text-xs'>
                {staged.map((file, i) => (
                  <li key={`${file.name}:${String(i)}`} className='flex items-center gap-1'>
                    <span className='truncate'>{file.name}</span>
                    <button
                      type='button'
                      aria-label={`Remove ${file.name}`}
                      className='rounded p-0.5 hover:bg-muted'
                      onClick={() => setStaged((all) => all.filter((_, j) => j !== i))}
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
