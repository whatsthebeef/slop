import { canChooseType, SLOP_TYPES } from '@slop/core';
import type { SlopType, WorkActor } from '@slop/core';
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

/** Who can do the work, and how (decisions come from learnings, never from this form). */
const ACTORS: readonly { readonly value: WorkActor; readonly label: string }[] = [
  { value: 'machine', label: 'Machine' },
  { value: 'human', label: 'Human' },
];

/** The modes an actor offers on this form: a machine's types, a human's action. */
const modesOf = (actor: WorkActor): readonly NewGlob['mode'][] => (actor === 'human' ? ['action'] : SLOP_TYPES);

/** Choosing who keeps the form valid: an action has no environment, files or run to start; a machine is a same until chosen. */
export const withActor = (form: NewGlob, actor: WorkActor): NewGlob => {
  if (actor === form.actor) return form;
  if (actor === 'human') {
    const next: NewGlob = { ...form, actor, mode: 'action', environment: null, autoTrigger: false };
    delete next.start;
    delete next.files;
    delete next.fix;
    delete next.fixSource;
    delete next.workKind;
    delete next.workKindSource;
    delete next.inferenceReason;
    return next;
  }
  return { ...form, actor, mode: 'same' };
};

/** A mode change keeps the fix flag valid: a fix is never a super. */
export const withMode = (form: NewGlob, mode: NewGlob['mode']): NewGlob =>
  mode === 'super' && form.fix === true ? { ...form, mode, fix: false, fixSource: 'person' } : { ...form, mode };

const empty = (): NewGlob => ({
  title: '',
  actor: 'machine',
  mode: 'same',
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
  initialGroup,
  open,
  initialRequest = '',
  fromInbox,
  onOpenChange,
  onCreate,
}: {
  board: BoardView;
  groups: readonly string[];
  /** The group the form starts with (the group page's Add glob); the form still shows it and it can be changed. */
  initialGroup?: string;
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
  const blank = (): NewGlob => ({ ...empty(), group: initialGroup ?? null });
  const [staged, setStaged] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [form, setForm] = useState<NewGlob>(blank);
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
  const human = form.actor === 'human';
  const valid = form.title.trim() !== '' && !(form.mode === 'super' && form.fix === true);
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);

  /** Intake: the LLM proposes the fields from free text; the person checks them before Create. */
  const processRequest = async () => {
    setProcessing(true);
    setError(null);
    try {
      const proposal = await api.intake(board.id, request);
      const reasons = [...new Set([proposal.fixReason, proposal.workKindReason].filter((r): r is string => r !== null && r.trim() !== ''))];
      setForm({
        title: proposal.title,
        plan: proposal.plan,
        actor: 'machine',
        mode: chooses(proposal.type) ? proposal.type : 'same',
        // Inferred, shown as chips the person can flip (a flip is theirs and sticks).
        fix: proposal.fix && proposal.type !== 'super',
        fixSource: proposal.fixSource,
        workKind: proposal.workKind,
        workKindSource: proposal.workKindSource,
        ...(reasons.length === 0 ? {} : { inferenceReason: reasons.join(' ').slice(0, 500) }),
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
        ...(human ? { assignee: (form.assignee ?? '').trim() === '' ? null : (form.assignee ?? '').trim() } : {}),
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
      setForm(blank());
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
      <DialogContent
        title='New glob'
        className='max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0'
      >
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
              Who
              <Select value={form.actor} data-testid='actor' onChange={(e) => setForm(withActor(form, e.target.value as WorkActor))}>
                {ACTORS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Label>
            {/* How: only the modes of the chosen actor. */}
            <Label>
              How
              <Select
                value={form.mode}
                data-testid='mode'
                title={!human && types.some((t) => !chooses(t)) ? CHOOSE_TYPE_TOOLTIP : undefined}
                onChange={(e) => setForm(withMode(form, e.target.value as NewGlob['mode']))}
              >
                {modesOf(form.actor)
                  .filter((m) => m === 'action' || types.includes(m))
                  .map((m) => (
                    <option key={m} disabled={m !== 'action' && !chooses(m)} title={m === 'action' || chooses(m) ? undefined : CHOOSE_TYPE_TOOLTIP}>
                      {m}
                    </option>
                  ))}
              </Select>
            </Label>
            {human && (
              <Label>
                Assignee (optional)
                <Input
                  value={form.assignee ?? ''}
                  placeholder='Email; empty means anyone'
                  data-testid='assignee'
                  onChange={(e) => setForm({ ...form, assignee: e.target.value })}
                />
              </Label>
            )}
            <Label>
              Group
              <GroupInput
                groups={groups}
                value={form.group ?? ''}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
              />
            </Label>
            {!human && (
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
            )}
          </div>
          {insight !== null && insight.needsConfirmation && !confirmed && (
            <div className='grid gap-1 rounded border border-amber/60 bg-amber/10 p-2 text-xs' data-testid='intake-unsure'>
              <p>
                Intake is not sure whether this is a fix ({insight.fix ? 'a fix' : 'not a fix'}
                {insight.categoryReason === null ? '' : `: ${insight.categoryReason}`}). Check the chip below, then confirm.
              </p>
              <Button type='button' variant='outline' size='sm' className='w-fit' onClick={() => setConfirmed(true)}>
                Looks right
              </Button>
            </div>
          )}
          {!human && form.fix !== undefined && form.workKind !== undefined && (
            <div className='flex flex-wrap items-center gap-2 text-xs' data-testid='kind-chips'>
              <button
                type='button'
                aria-pressed={form.fix}
                disabled={form.mode === 'super'}
                title={form.mode === 'super' ? 'A fix is never a super' : form.fixSource === 'person' ? 'Set by you' : 'Inferred from the request: click to flip'}
                className={`inline-flex h-7 items-center rounded-full border px-2.5 ${form.fix ? 'border-foreground bg-muted font-medium' : 'border-edge text-muted-foreground hover:text-foreground'}`}
                data-testid='chip-fix'
                onClick={() => setForm({ ...form, fix: !form.fix, fixSource: 'person' })}
              >
                {form.fix ? 'Fix' : 'Not a fix'}
              </button>
              {form.inferenceReason != null && <span className='text-muted-foreground'>{form.inferenceReason}</span>}
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
          {form.mode === 'super' && (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={form.start === false}
                onChange={(e) => setForm({ ...form, ...(e.target.checked ? { start: false } : { start: true }) })}
              />
              Park in Planning until someone picks it up to pair
            </label>
          )}
          {form.mode === 'same' && (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={form.autoTrigger}
                onChange={(e) => setForm({ ...form, autoTrigger: e.target.checked })}
              />
              Start a routine run straight away
            </label>
          )}
          {form.mode === 'same' && form.autoTrigger && reason !== null && (
            <p className='text-xs text-muted-foreground'>{reason}</p>
          )}
          {form.mode === 'super' && form.fix === true && <p className='text-xs text-red'>A fix cannot be a super.</p>}
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
