import { CATEGORIES, isValidCombination, machine, SLOP_TYPES } from '@slop/core';
import type { Action, Category, Role, SlopType } from '@slop/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { ACTION_LABELS } from '@/lib/api';
import type { BoardView, GlobChanges, GlobView } from '@/lib/api';
import { ArtifactsSection } from './artifacts';
import type { ArtifactRef } from './artifacts';
import { GroupChip } from './glob-card';
import { LabelChips, LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
import { PlanEditor } from './plan-editor';
import { Tip } from './ui/tip';

const STATUS_TEXT: Record<GlobView['status'], string> = {
  planning: 'Planning',
  implementing: 'A routine is implementing',
  in_progress: 'In progress',
  failed: 'Failed',
  pr_open: 'PR open for review',
  merging: 'Merging',
  reviewing: 'Merged; awaiting sign-off',
  signed_off: 'Signed off',
};

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const ACTION_TIPS: Partial<Record<Action, string>> = {
  merge_continue: "Lands what's done on main; the glob stays in Doing and gets a new PR on the next push",
  mark_ready: 'Marks the draft PR ready for review',
};

const { POSTPLAN_NOT_AT_HEAD } = machine;

/**
 * A super's actions that need the latest postplan at the PR head, shown disabled with the reason
 * while they would otherwise apply.
 */
const waitingOnPostplan = (glob: GlobView, actions: readonly Action[], role: Role): Action[] => {
  // QA and PO can't take these actions at all, so a postplan reason would mislead them.
  if (glob.type !== 'super' || role === 'qa' || role === 'po') return [];
  const waiting: Action[] = [];
  if (actions.includes('merge') && !actions.includes('merge_continue')) waiting.push('merge_continue');
  if (glob.status === 'in_progress' && glob.pr?.state === 'draft' && !actions.includes('mark_ready')) {
    waiting.push('mark_ready');
  }
  return waiting;
};

export const GlobDialog = ({
  board,
  glob,
  initialArtifact,
  onClose,
  onUpdate,
  onAction,
  onReviewLabel,
  onDelete,
}: {
  board: BoardView;
  glob: GlobView;
  /** The artifact to show first (from a card icon). */
  initialArtifact: ArtifactRef | null;
  onClose: () => void;
  onUpdate: (changes: GlobChanges) => Promise<void>;
  onAction: (action: Action) => Promise<void>;
  onReviewLabel: ReviewLabel;
  onDelete: () => Promise<void>;
}) => {
  const [draft, setDraft] = useState<GlobChanges>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  useEffect(() => setDraft({}), [glob.id]);
  useEffect(() => setArtifact(initialArtifact), [glob.id, initialArtifact]);

  const merged = { ...glob, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const actions = (glob.allowedActions ?? []).filter((a) => a !== 'delete');
  const disabled = waitingOnPostplan(glob, actions, board.role);
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className='max-w-2xl'
        title={
          <span>
            <span className='font-mono text-muted-foreground'>{glob.id}</span> {glob.title}
          </span>
        }
      >
        <div className='grid gap-4'>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span className='rounded bg-muted px-2 py-0.5'>{STATUS_TEXT[glob.status]}</span>
            {glob.group !== null && <GroupChip name={glob.group} />}
            <LabelChips glob={glob} />
            <span className='ml-auto text-xs text-muted-foreground'>
              branch <span className='font-mono'>{glob.branch}</span> · v{glob.version}
            </span>
          </div>

          {glob.failure !== null && (
            <p className='rounded border border-red/40 bg-red/10 p-2 text-sm'>Failed: {glob.failure.reason}</p>
          )}

          <LabelReviews glob={glob} onReview={onReviewLabel} />

          {actions.length + disabled.length > 0 && (
            <div className='grid gap-1'>
              <div className='flex flex-wrap gap-2'>
                {actions.map((action) => {
                  const button = (
                    <Button
                      key={action}
                      variant={action === 'start_again' ? 'outline' : 'default'}
                      size='sm'
                      disabled={busy}
                      onClick={() => void run(() => onAction(action))}
                    >
                      {ACTION_LABELS[action]}
                    </Button>
                  );
                  const tip = ACTION_TIPS[action];
                  return tip === undefined ? (
                    button
                  ) : (
                    <Tip key={action} text={tip}>
                      {button}
                    </Tip>
                  );
                })}
                {disabled.map((action) => (
                  <Tip key={action} text={POSTPLAN_NOT_AT_HEAD}>
                    <Button variant='outline' size='sm' disabled>
                      {ACTION_LABELS[action]}
                    </Button>
                  </Tip>
                ))}
              </div>
              {disabled.length > 0 && (
                <p className='text-xs text-muted-foreground'>
                  {disabled.map((a) => ACTION_LABELS[a]).join(' and ')}: {POSTPLAN_NOT_AT_HEAD}
                </p>
              )}
            </div>
          )}

          <div className='grid gap-3'>
            <Label>
              Title
              <Input value={merged.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Label>
            <Label>
              Summary
              <Textarea value={merged.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
            </Label>
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <Label>
                Type
                <Select
                  value={merged.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as SlopType })}
                >
                  {SLOP_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Label>
              <Label>
                Category
                <Select
                  value={merged.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} disabled={!isValidCombination(merged.type, c)}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Label>
              <Label>
                Group
                <Input
                  value={merged.group ?? ''}
                  onChange={(e) => setDraft({ ...draft, group: e.target.value === '' ? null : e.target.value })}
                />
              </Label>
              <Label>
                Environment
                <Select
                  value={merged.environment ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, environment: e.target.value === '' ? null : e.target.value })
                  }
                >
                  <option value=''>None</option>
                  {deployable.map((env) => (
                    <option key={env.name}>{env.name}</option>
                  ))}
                </Select>
              </Label>
            </div>
            {dirty && (
              <div className='flex justify-end gap-2'>
                <Button variant='outline' size='sm' onClick={() => setDraft({})}>
                  Discard
                </Button>
                <Button
                  size='sm'
                  disabled={busy || !isValidCombination(merged.type, merged.category)}
                  onClick={() =>
                    void run(async () => {
                      await onUpdate(draft);
                      setDraft({});
                    })
                  }
                >
                  Save
                </Button>
              </div>
            )}
          </div>

          <PlanEditor globId={glob.id} summary={glob.summary} />

          <ArtifactsSection globId={glob.id} artifacts={glob.artifacts ?? []} selected={artifact} onSelect={setArtifact} />

          <dl className='grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground'>
            <dt>Planner</dt>
            <dd>{glob.planner}</dd>
            <dt>Implementer</dt>
            <dd>{glob.implementer ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{when(glob.createdAt)}</dd>
            <dt>Pull request</dt>
            <dd>
              {glob.pr === null ? (
                glob.provisioning === 'failed'
                  ? 'provisioning failed; retrying'
                  : glob.provisioning === 'none'
                    ? 'opened when work starts'
                    : glob.prs.length > 0
                      ? 'a new one opens on the next push'
                      : 'opening…'
              ) : board.repo === null ? (
                `#${glob.pr.number} (${glob.pr.state})`
              ) : (
                <a
                  className='underline'
                  href={`https://github.com/${board.repo}/pull/${glob.pr.number}`}
                  target='_blank'
                  rel='noreferrer'
                >
                  #{glob.pr.number} ({glob.pr.state})
                </a>
              )}
            </dd>
            {glob.prs.length > 0 && (
              <>
                <dt>Merged and continued</dt>
                <dd className='flex flex-wrap gap-x-2'>
                  {glob.prs.map((p) => (
                    <span key={p.number} title={`${p.mergeSha.slice(0, 7)} · ${when(p.mergedAt)}`}>
                      {board.repo === null ? (
                        `#${p.number}`
                      ) : (
                        <a
                          className='underline'
                          href={`https://github.com/${board.repo}/pull/${p.number}`}
                          target='_blank'
                          rel='noreferrer'
                        >
                          #{p.number}
                        </a>
                      )}{' '}
                      <span className='font-mono'>{p.mergeSha.slice(0, 7)}</span>
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>

          {glob.runs.length > 0 && (
            <div className='grid gap-1'>
              <h3 className='text-xs font-semibold text-muted-foreground'>Routine runs</h3>
              {[...glob.runs].reverse().map((run) => (
                <div key={run.id} className='flex justify-between gap-2 rounded bg-muted px-2 py-1 text-xs'>
                  <span>
                    {run.state === 'ended' ? (run.outcome ?? 'ended') : run.state} · owner {run.routineOwner}
                    {run.sessionUrl !== null && (
                      <>
                        {' · '}
                        <a className='underline' href={run.sessionUrl} target='_blank' rel='noreferrer'>
                          Open in Claude
                        </a>
                      </>
                    )}
                    {run.failureReason !== null && <span className='block text-red'>{run.failureReason}</span>}
                  </span>
                  <span className='text-muted-foreground'>
                    queued {when(run.queuedAt)}
                    {run.lastProgressAt !== null && ` · last progress ${when(run.lastProgressAt)}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className='border-t pt-3'>
            {confirmDelete ? (
              <div className='grid gap-2 rounded border border-destructive/50 p-3 text-sm'>
                <p>
                  <strong>Delete {glob.id} permanently?</strong> This removes the glob, its branch, its PR, its
                  artifacts and its events, so its time leaves the reports. There is no archive.
                </p>
                <div className='flex justify-end gap-2'>
                  <Button variant='outline' size='sm' onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                  <Button variant='destructive' size='sm' disabled={busy} onClick={() => void run(onDelete)}>
                    Delete permanently
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant='ghost' size='sm' className='text-destructive' onClick={() => setConfirmDelete(true)}>
                Delete…
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

