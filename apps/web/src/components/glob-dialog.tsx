import { CATEGORIES, isValidCombination, machine, SLOP_TYPES } from '@slop/core';
import type { Action, Category, EditFailure, SlopType } from '@slop/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { ACTION_LABELS } from '@/lib/api';
import type { BoardView, GlobChanges, GlobView } from '@/lib/api';
import { viewStatusLine, waitingFor } from '@/lib/status-line';
import { ArtifactsSection } from './artifacts';
import { CodeReviewSection } from './code-review';
import { DeploysSection, EnvironmentsSection, TestsSection } from './deploys';
import type { ArtifactRef } from './artifacts';
import { GroupChip } from './glob-card';
import { LabelChips, LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
import { PlanEditor } from './plan-editor';
import { ReviewFindings } from './review-findings';
import { cn } from '@/lib/utils';
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
  resolve_conflict: 'Asks the Claude GitHub App, in a PR comment, to merge the base branch into this branch and resolve the conflicts',
};

export const GlobDialog = ({
  board,
  glob,
  initialArtifact,
  onClose,
  onUpdate,
  onReload,
  onAction,
  onReviewLabel,
  onDelete,
}: {
  board: BoardView;
  glob: GlobView;
  /** The artifact to show first (from a card icon). */
  initialArtifact: ArtifactRef | null;
  onClose: () => void;
  /** Saves the edits; resolves null when saved, or why the server refused them. */
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  /** Loads the glob's latest values into the view (after a version conflict). */
  onReload: () => Promise<void>;
  /** Resolves false when the action failed. */
  onAction: (action: Action) => Promise<boolean>;
  onReviewLabel: ReviewLabel;
  onDelete: () => Promise<void>;
}) => {
  const [draft, setDraft] = useState<GlobChanges>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  useEffect(() => {
    setDraft({});
    setFailure(null);
  }, [glob.id]);
  /** Edits the draft; a refusal shown earlier no longer applies to what the person is typing. */
  const edit = (changes: GlobChanges) => {
    setDraft((d) => ({ ...d, ...changes }));
    setFailure(null);
  };
  const swapBlocker =
    glob.type === 'sub' ? null : machine.sameSuperSwapBlocker(glob);
  useEffect(() => setArtifact(initialArtifact), [glob.id, initialArtifact]);

  const merged = { ...glob, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const actions = (glob.allowedActions ?? []).filter((a) => a !== 'delete');
  const disabled = waitingFor(glob, actions, board.role);
  const status = viewStatusLine(glob, new Date().toISOString(), disabled);
  // Ready for review changes nothing until GitHub confirms, so say it was asked for meanwhile.
  const [readyAsked, setReadyAsked] = useState(false);
  const readyPending = readyAsked && glob.status === 'in_progress' && glob.pr?.state === 'draft';
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
  const reviewedAtHead = (glob.artifacts ?? []).some(
    (a) => a.kind === 'local_review' && machine.sameCommit(a.commitSha, glob.pr?.headSha),
  );
  const markReady = () =>
    run(async () => {
      setConfirmingReady(false);
      if (await onAction('mark_ready')) setReadyAsked(true);
    });
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
        className='max-w-[63rem]'
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
              branch{' '}
              {board.repo === null ? (
                <span className='font-mono'>{glob.branch}</span>
              ) : (
                <a
                  className='font-mono underline-offset-2 hover:underline'
                  href={`https://github.com/${board.repo}/compare/${board.baseBranch}...${glob.branch}`}
                  target='_blank'
                  rel='noreferrer'
                  title={`Compare ${glob.branch} with ${board.baseBranch} on GitHub`}
                >
                  {glob.branch}
                </a>
              )}{' '}
              · v{glob.version}
            </span>
          </div>

          {status !== null && (
            <p className={cn('text-sm font-medium', status.tone)} data-testid='status-line' data-kind={status.kind}>
              {status.full}
              {status.url !== null && (
                <>
                  {' ('}
                  <a className='underline' href={status.url} target='_blank' rel='noreferrer'>
                    check run
                  </a>
                  )
                </>
              )}
              {status.doing !== null && (
                <span className='font-normal'>
                  {' — '}
                  {status.sessionUrl === null ? (
                    status.doing
                  ) : (
                    <a className='underline' href={status.sessionUrl} target='_blank' rel='noreferrer'>
                      {status.doing}
                    </a>
                  )}
                </span>
              )}
            </p>
          )}
          {(glob.failure?.conflict ?? glob.conflict) != null && glob.implementer !== null && (
            <div className='grid gap-1 rounded border border-edge p-2 text-sm'>
              <span>Resolve it locally, then push (Start again stays available):</span>
              <code className='block whitespace-pre-wrap font-mono text-xs'>
                {`sstor --glob ${glob.id} --resolve\n# or by hand:\ngit fetch origin ${(glob.failure?.conflict ?? glob.conflict)?.base ?? ''} && git checkout ${glob.branch} && git merge origin/${(glob.failure?.conflict ?? glob.conflict)?.base ?? ''}\n# resolve the conflicts, commit\ngit push origin ${glob.branch}`}
              </code>
            </div>
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
                      onClick={() => {
                        if (action === 'mark_ready') {
                          if (reviewedAtHead) void markReady();
                          else setConfirmingReady(true);
                          return;
                        }
                        void run(async () => {
                          await onAction(action);
                        });
                      }}
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
                {disabled.map(({ action, tip }) => (
                  <Tip key={action} text={tip}>
                    <Button variant='outline' size='sm' disabled>
                      {ACTION_LABELS[action]}
                    </Button>
                  </Tip>
                ))}
              </div>
              {confirmingReady && (
                <div role='alert' className='flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs'>
                  <span className='flex-1'>
                    No local review is recorded at the PR head: the change_reviewer and /finalise haven't run for{' '}
                    {glob.pr?.headSha?.slice(0, 7) ?? 'the head'}. Mark it ready anyway?
                  </span>
                  <Button size='sm' variant='ghost' onClick={() => setConfirmingReady(false)}>
                    Cancel
                  </Button>
                  <Button size='sm' disabled={busy} onClick={() => void markReady()} data-testid='confirm-ready'>
                    Ready for review
                  </Button>
                </div>
              )}
              {readyPending && (
                <p role='status' className='text-xs text-muted-foreground'>
                  Asked GitHub to mark PR #{glob.pr.number} ready; the glob moves to PR open when GitHub confirms.
                </p>
              )}
            </div>
          )}

          <div className='grid gap-3'>
            <Label>
              Title
              <Input value={merged.title} onChange={(e) => edit({ title: e.target.value })} />
            </Label>
            <Label>
              Summary
              <Textarea value={merged.summary} onChange={(e) => edit({ summary: e.target.value })} />
            </Label>
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <Label>
                Type
                <Select
                  value={merged.type}
                  onChange={(e) => edit({ type: e.target.value as SlopType })}
                >
                  {SLOP_TYPES.map((t) => (
                    <option key={t} disabled={swapBlocker !== null && t !== glob.type && t !== 'sub' && glob.type !== 'sub'}>
                      {t}
                    </option>
                  ))}
                </Select>
                {swapBlocker !== null && glob.type !== 'sub' && (
                  <span className='text-xs font-normal text-muted-foreground'>{swapBlocker}</span>
                )}
              </Label>
              <Label>
                Category
                <Select
                  value={merged.category}
                  onChange={(e) => edit({ category: e.target.value as Category })}
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
                  onChange={(e) => edit({ group: e.target.value === '' ? null : e.target.value })}
                />
              </Label>
              <Label>
                Environment
                <Select
                  value={merged.environment ?? ''}
                  onChange={(e) =>
                    edit({ environment: e.target.value === '' ? null : e.target.value })
                  }
                >
                  <option value=''>None</option>
                  {deployable.map((env) => (
                    <option key={env.name}>{env.name}</option>
                  ))}
                </Select>
              </Label>
            </div>
            {failure !== null && (
              <div role='alert' className='flex flex-wrap items-center justify-end gap-2 text-sm text-red'>
                <span>{failure.message}</span>
                {failure.conflict && (
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await onReload();
                        setFailure(null);
                      })
                    }
                  >
                    Reload latest
                  </Button>
                )}
              </div>
            )}
            {dirty && (
              <div className='flex justify-end gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    setDraft({});
                    setFailure(null);
                  }}
                >
                  Discard
                </Button>
                <Button
                  size='sm'
                  disabled={busy || !isValidCombination(merged.type, merged.category)}
                  onClick={() =>
                    void run(async () => {
                      const refused = await onUpdate(draft);
                      setFailure(refused);
                      if (refused === null) setDraft({});
                    })
                  }
                >
                  Save
                </Button>
              </div>
            )}
          </div>

          <PlanEditor globId={glob.id} summary={glob.summary} />

          <DeploysSection board={board} glob={glob} />

          <EnvironmentsSection board={board} glob={glob} />

          <TestsSection glob={glob} />

          <ArtifactsSection globId={glob.id} artifacts={glob.artifacts ?? []} selected={artifact} onSelect={setArtifact} />

          <CodeReviewSection globId={glob.id} />

          <ReviewFindings globId={glob.id} />

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

