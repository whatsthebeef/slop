import { EFFECT_CHECK_GLOBS_MAX, EFFECT_CHECK_GLOBS_MIN, ENVIRONMENT_ROLES, recentPeriods, ROLES } from '@slop/core';
import type { AgentKbApproval, DeployIntegration, Environment, Role, SizeOutcome, SubLimitChange } from '@slop/core';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { GroupChip } from '@/components/glob-card';
import { JobStatus } from '@/components/kb-proposals';
import { ReadinessChecklist } from '@/components/readiness';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { usePageContext } from '@/lib/page-context';
import { useToast } from '@/toast';

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

export const SettingsPage = () => {
  const boardId = Number(useParams().boardId);
  usePageContext({ type: 'settings' });
  const client = useQueryClient();
  const toast = useToast();
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const members = useQuery({ queryKey: ['members', boardId], queryFn: () => api.members(boardId) });
  // Re-checked when the tab regains focus, so returning from GitHub's install page updates it.
  const connection = useQuery({
    queryKey: ['repo-connection', boardId],
    queryFn: () => api.repoConnection(boardId),
    refetchOnWindowFocus: true,
  });
  const [repo, setRepo] = useState('');
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [timeZone, setTimeZone] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('dev');
  const [deploy, setDeploy] = useState<DeployIntegration | null>(null);
  const [effectCheckGlobs, setEffectCheckGlobs] = useState('');
  const [agentKbApproval, setAgentKbApproval] = useState<AgentKbApproval>('docs');

  useEffect(() => {
    if (board.data === undefined) return;
    setEnvs([...board.data.environments]);
    setTimeZone(board.data.timeZone);
    setBaseBranch(board.data.baseBranch);
    setRepo(board.data.repo ?? '');
    setDeploy(board.data.deploy);
    setEffectCheckGlobs(String(board.data.effectCheckGlobs));
    setAgentKbApproval(board.data.agentKbApproval);
  }, [board.data]);

  const save = useMutation({
    mutationFn: () => {
      if (board.data === undefined) throw new Error('No board');
      return api.updateSettings(boardId, board.data.version, {
        environments: envs,
        timeZone,
        baseBranch,
        repo: repo.trim() === '' ? null : repo.trim(),
        deploy,
        agentKbApproval,
        // Checked by the server (3 to 50); a blank field leaves it as it is.
        ...(effectCheckGlobs.trim() === '' ? {} : { effectCheckGlobs: Number(effectCheckGlobs) }),
      });
    },
    onSuccess: () => {
      toast('Settings saved');
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      void client.invalidateQueries({ queryKey: ['repo-connection', boardId] });
    },
    onError: (e) => toast(message(e)),
  });

  const setMember = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) => api.setMember(boardId, email, role),
    onSuccess: () => {
      setNewEmail('');
      void client.invalidateQueries({ queryKey: ['members', boardId] });
    },
    onError: (e) => toast(message(e)),
  });

  const removeMember = useMutation({
    mutationFn: (email: string) => api.removeMember(boardId, email),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['members', boardId] }),
    onError: (e) => toast(message(e)),
  });

  if (board.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;
  const admin = board.data.role === 'admin';

  return (
    <main className='mx-auto grid max-w-2xl gap-8 p-6'>
      <section className='grid gap-2'>
        <h2 className='text-sm font-semibold'>Repository</h2>
        {connection.data === undefined ? (
          <p className='text-sm text-muted-foreground'>Checking…</p>
        ) : connection.data.repo === null ? (
          <p className='text-sm text-muted-foreground'>No repository set. Add one below (owner/name).</p>
        ) : !connection.data.configured ? (
          <p className='text-sm'>
            slop's GitHub App isn't set up yet. An admin creates it at <a className='underline' href='/setup/github-app'>/setup/github-app</a>.
          </p>
        ) : (
          <div className='flex flex-wrap items-center gap-3 text-sm'>
            <span className='font-mono'>{connection.data.repo}</span>
            {connection.data.connected ? (
              <span className='rounded-sm border border-foreground bg-lcd px-2 py-0.5 font-mono text-xs text-lcd-foreground'>Connected</span>
            ) : (
              <span className='rounded-sm border border-required-border px-2 py-0.5 font-mono text-xs text-required'>Not installed</span>
            )}
            {!connection.data.connected && connection.data.installUrl !== null && (
              <a
                className='rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground'
                href={connection.data.installUrl}
                target='_blank'
                rel='noreferrer'
              >
                Install {connection.data.appName} on GitHub
              </a>
            )}
            <Button variant='ghost' size='sm' onClick={() => void connection.refetch()}>
              Check again
            </Button>
          </div>
        )}
        {connection.data !== undefined && !connection.data.connected && connection.data.configured && connection.data.repo !== null && (
          <p className='text-xs text-muted-foreground'>
            On GitHub, choose the repository's account, then "Only select repositories" and add {connection.data.repo}. This page
            updates when you come back.
          </p>
        )}
      </section>

      <ReadinessChecklist board={board.data} />

      <section className='grid gap-3'>
        <h2 className='text-sm font-semibold'>Board</h2>
        <Label>
          Repository (owner/name)
          <Input value={repo} disabled={!admin} onChange={(e) => setRepo(e.target.value)} />
        </Label>
        <div className='grid grid-cols-2 gap-3'>
          <Label>
            Base branch
            <Input value={baseBranch} disabled={!admin} onChange={(e) => setBaseBranch(e.target.value)} />
          </Label>
          <Label>
            Working-hours time zone
            <Input value={timeZone} disabled={!admin} onChange={(e) => setTimeZone(e.target.value)} />
          </Label>
        </div>
        <h3 className='text-xs font-semibold text-muted-foreground'>Environments</h3>
        {envs.map((env, i) => (
          <div key={i} className='flex items-center gap-2'>
            <Input
              value={env.name}
              disabled={!admin}
              onChange={(e) => setEnvs(envs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <label className='flex shrink-0 items-center gap-1 text-xs'>
              <input
                type='checkbox'
                disabled={!admin}
                checked={env.allowBranchDeploy}
                onChange={(e) =>
                  // An environment without branch deploys can't be the subs' default.
                  setEnvs(
                    envs.map((x, j) =>
                      j !== i
                        ? x
                        : e.target.checked
                          ? { ...x, allowBranchDeploy: true }
                          : { ...x, allowBranchDeploy: false, subDefault: undefined },
                    ),
                  )
                }
              />
              branch deploys
            </label>
            <label
              className='flex shrink-0 items-center gap-1 text-xs'
              title='Subs created without an environment get this one'
            >
              <input
                type='checkbox'
                disabled={!admin || !env.allowBranchDeploy}
                checked={env.subDefault === true}
                onChange={(e) =>
                  // At most one default: choosing one clears the others.
                  setEnvs(
                    envs.map((x, j) =>
                      j === i && e.target.checked ? { ...x, subDefault: true } : { ...x, subDefault: undefined },
                    ),
                  )
                }
              />
              default for subs
            </label>
            <Select
              className='w-32 shrink-0 text-xs'
              aria-label={`What deploys ${env.name || 'this environment'}`}
              title='Integration: the base branch pipeline deploys here. Release: release refs are deployed here. Slop shows which globs each one holds.'
              disabled={!admin}
              value={env.role ?? ''}
              onChange={(e) => {
                const role = ENVIRONMENT_ROLES.find((r) => r === e.target.value);
                // Only a release environment can be production.
                setEnvs(envs.map((x, j) => (j !== i ? x : { ...x, role, production: role === 'release' ? x.production : undefined })));
              }}
            >
              <option value=''>no pipeline</option>
              <option value='integration'>integration</option>
              <option value='release'>release</option>
            </Select>
            <label
              className='flex shrink-0 items-center gap-1 text-xs'
              title='Cards warn when a glob reaches production before sign-off'
            >
              <input
                type='checkbox'
                disabled={!admin || env.role !== 'release'}
                checked={env.production === true}
                onChange={(e) =>
                  // At most one production environment: choosing one clears the others.
                  setEnvs(
                    envs.map((x, j) =>
                      j === i && e.target.checked ? { ...x, production: true } : { ...x, production: undefined },
                    ),
                  )
                }
              />
              production
            </label>
            {admin && (
              <Button variant='ghost' size='sm' onClick={() => setEnvs(envs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        <Label>
          Effect checks: globs compared before and after an approved change ({EFFECT_CHECK_GLOBS_MIN}–{EFFECT_CHECK_GLOBS_MAX})
          <Input
            type='number'
            min={EFFECT_CHECK_GLOBS_MIN}
            max={EFFECT_CHECK_GLOBS_MAX}
            step={1}
            className='w-24'
            value={effectCheckGlobs}
            disabled={!admin}
            onChange={(e) => setEffectCheckGlobs(e.target.value)}
            data-testid='effect-check-globs'
          />
        </Label>
        <h3 className='text-xs font-semibold text-muted-foreground'>Knowledge</h3>
        <label className='flex items-center gap-2 text-sm' title='Local-run spec, merge policy and whole documents always need a person'>
          <input
            type='checkbox'
            disabled={!admin}
            checked={agentKbApproval === 'docs_and_agent_files'}
            onChange={(e) => setAgentKbApproval(e.target.checked ? 'docs_and_agent_files' : 'docs')}
            data-testid='agent-kb-approval'
          />
          Agents may approve agent-file and contradicting items
        </label>
        <SubLimit boardId={boardId} admin={admin} />
        <SizeThreshold boardId={boardId} admin={admin} />
        <IntakeAccuracyView boardId={boardId} admin={admin} />
        <IntegrationToken boardId={boardId} admin={admin} />
        <DeploySettings
          deploy={deploy}
          environments={envs.filter((e) => e.allowBranchDeploy && e.name.trim() !== '').map((e) => e.name)}
          disabled={!admin}
          onChange={setDeploy}
        />
        {admin && (
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={() => setEnvs([...envs, { name: '', allowBranchDeploy: true }])}>
              Add environment
            </Button>
            <Button size='sm' disabled={save.isPending} onClick={() => save.mutate()}>
              Save settings
            </Button>
          </div>
        )}
      </section>

      <TimeReports boardId={boardId} />

      <section className='grid gap-3'>
        <h2 className='text-sm font-semibold'>Members</h2>
        {members.data?.map((m) => (
          <div key={m.email} className='flex items-center gap-2 text-sm'>
            <span className='flex-1'>{m.email}</span>
            <Select
              className='w-28'
              value={m.role}
              disabled={!admin}
              onChange={(e) => setMember.mutate({ email: m.email, role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            {admin && (
              <Button variant='ghost' size='sm' onClick={() => removeMember.mutate(m.email)}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {admin && (
          <form
            className='flex gap-2'
            onSubmit={(e) => {
              e.preventDefault();
              setMember.mutate({ email: newEmail, role: newRole });
            }}
          >
            <Input type='email' placeholder='email' value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            <Select className='w-28' value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Button type='submit'>Add</Button>
          </form>
        )}
      </section>
    </main>
  );
};

const CODEBUILD_DEFAULT: DeployIntegration = { provider: 'codebuild', region: 'us-east-1', defaultProject: '', projects: {} };
const GITHUB_DEFAULT: DeployIntegration = { provider: 'github_actions', workflow: 'slop-deploy.yml' };

const lines = (n: number) => n.toLocaleString('en');

/** A sub's changed lines; unknown when neither its gate verdict nor its merge commit gave a count. */
const changed = (n: number | null) => (n === null ? 'line count unknown' : `${lines(n)} lines`);

/** Why an outcome moved the limit, in words. */
const outcomeText = (change: SubLimitChange): string =>
  change.outcome === 'merged_unchanged'
    ? `Converted for its size (${changed(change.changedLines)}) and merged unchanged`
    : `Passed the gate (${changed(change.changedLines)}) and needed fixes after merging`;

/**
 * The learned sub size limit: read-only (slop moves it with outcomes), with its history. Every value is rendered as
 * text, including the evidence quotes, which come from labels' checklists and bug reports.
 */
const SIZE_OUTCOME_TEXT: Record<SizeOutcome, string> = {
  kept_whole_clean: 'Flagged, kept whole and merged cleanly: raised',
  unflagged_struggled: 'Not flagged, and it struggled: lowered',
  flag_confirmed: 'Flag confirmed: unchanged',
};

/**
 * The learned size threshold (oversized flag): read-only, with its history. Evidence is rendered as text.
 */
const SizeThreshold = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const threshold = useQuery({ queryKey: ['size-threshold', boardId], queryFn: () => api.sizeThreshold(boardId) });
  const jobs = useQuery({ queryKey: ['kb-jobs', boardId], queryFn: () => api.boardJobs(boardId) });
  const lastRun = jobs.data === undefined ? undefined : (jobs.data.find((j) => j.job === 'size_threshold')?.lastRunAt ?? null);
  const seenRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRun === undefined) return;
    if (seenRun.current !== undefined && seenRun.current !== lastRun) void client.invalidateQueries({ queryKey: ['size-threshold', boardId] });
    seenRun.current = lastRun;
  }, [client, boardId, lastRun]);
  if (threshold.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the size threshold.
        <Button size='sm' variant='outline' onClick={() => void threshold.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (threshold.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the size threshold…</p>;
  const { current, bounds, history } = threshold.data;
  return (
    <div className='grid gap-2' data-testid='size-threshold'>
      <p className='text-sm'>
        Oversized threshold: more than {current.maxTasks} tasks or {current.maxParts} independent parts (learned from outcomes)
      </p>
      <p className='text-xs text-muted-foreground'>
        Intake flags a glob above it and proposes a split. A flagged glob kept whole that merges cleanly raises the threshold; an
        unflagged glob that struggles (the most review rounds, a failed run, a very long PR, or a split after it started) lowers it.
        Tasks stay between {bounds.tasks.min} and {bounds.tasks.max}, parts between {bounds.parts.min} and {bounds.parts.max}, in steps of {bounds.step}.
      </p>
      <JobStatus boardId={boardId} admin={admin} job='size_threshold' />
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No outcomes recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Tasks / parts</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {history.map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {change.from.maxTasks} / {change.from.maxParts} → {change.to.maxTasks} / {change.to.maxParts}
                </td>
                <td className='pr-3'>
                  {SIZE_OUTCOME_TEXT[change.outcome]}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
                <td>
                  <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                    {change.globId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/** The board's integration token (the Meet notes script's credential): created and shown once, or revoked. */
const IntegrationToken = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['integration-token', boardId], queryFn: () => api.integrationToken(boardId) });
  // The secret lives only in this state: leaving the page loses it, as the server keeps just its hash.
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['integration-token', boardId] });
  const create = useMutation({
    mutationFn: () => api.createIntegrationToken(boardId),
    onSuccess: (made) => {
      setSecret(made.token);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeIntegrationToken(boardId),
    onSuccess: () => {
      setSecret(null);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  return (
    <div className='grid gap-2' data-testid='integration-token'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Integration token</h3>
      <p className='text-xs text-muted-foreground'>
        Lets an outside script (the Google Meet notes Apps Script) add items to this board's inbox, and nothing else.
        slop keeps only its hash, so copy it when it is shown. Creating a new token revokes the old one.
      </p>
      {status.data !== undefined && (
        <p className='text-sm'>
          {status.data.active ? `Active since ${new Date(status.data.createdAt ?? '').toLocaleString()}` : 'No active token'}
        </p>
      )}
      {secret !== null && (
        <p className='break-all rounded border p-2 font-mono text-xs' data-testid='integration-token-secret'>
          {secret}
        </p>
      )}
      {admin && (
        <div className='flex gap-2'>
          <Button size='sm' variant='outline' disabled={create.isPending} onClick={() => create.mutate()}>
            {status.data?.active === true ? 'Replace token' : 'Create token'}
          </Button>
          {status.data?.active === true && (
            <Button size='sm' variant='outline' disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/** Working hours and this board's time reports. The zone is the server's setting (one for every board), read-only here. */
const TimeReports = ({ boardId }: { boardId: number }) => {
  const toast = useToast();
  const overview = useQuery({ queryKey: ['reports', boardId], queryFn: () => api.reports(boardId) });
  // Fetched rather than linked, so a refusal (say the admin role was removed since the page loaded) shows as a message
  // instead of being saved as the CSV.
  const download = useMutation({
    mutationFn: (period: string) => api.report(boardId, period),
    onSuccess: (report) => {
      const url = URL.createObjectURL(new Blob([report.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `slop-report-${String(report.boardId)}-${report.period}.csv`;
      // Some browsers only download from a link in the document, and need the URL to outlive the click.
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    onError: (error) => toast(message(error)),
  });
  // An older server without reports, or no access: the section is left out.
  const timeZone = overview.data?.timeZone;
  if (timeZone === undefined) return null;
  // Reports are computed when downloaded, so any period that has begun can be offered; the running one counts up to now.
  const periods = recentPeriods(new Date().toISOString(), timeZone);
  return (
    <section className='grid gap-3' data-testid='time-reports'>
      <h2 className='text-sm font-semibold'>Time and reports</h2>
      <p className='text-sm'>
        Working hours: 09:00–17:00, weekdays, in <span className='font-mono'>{timeZone}</span>
      </p>
      <p className='text-xs text-muted-foreground'>
        Time counts toward each person's active glob (one at a time, across every board) while it is in Doing. This board's
        reports count only time on its globs and are worked out from the event log when you download them (% RnD per
        developer, as CSV).
      </p>
      {overview.data?.canDownload === true && (
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-sm'>
          {periods.map((p) => (
            <button
              key={p.key}
              type='button'
              className='font-mono underline disabled:opacity-50'
              disabled={download.isPending}
              onClick={() => download.mutate(p.key)}
            >
              {p.key}
            </button>
          ))}
        </div>
      )}
    </section>
  );
};

const rate = (value: number | null): string => (value === null ? '-' : `${Math.round(value * 100)}%`);
const median = (value: number | null, unit: string): string => (value === null ? '-' : `${Math.round(value * 10) / 10} ${unit}`);

/**
 * How often intake's category and type survived to the merge (spec, Intake: learned task categorisation): by the month a glob
 * was created and by prompt version, with typical size, effort and review rounds by kind. Outcomes settle 14 days after a merge.
 */
const IntakeAccuracyView = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const accuracy = useQuery({ queryKey: ['intake-accuracy', boardId], queryFn: () => api.intakeAccuracy(boardId) });
  if (accuracy.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load intake accuracy.
        <Button size='sm' variant='outline' onClick={() => void accuracy.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (accuracy.data === undefined) return <p className='text-sm text-muted-foreground'>Loading intake accuracy…</p>;
  const { snapshots, merged, corrected, byMonth, byPromptVersion, byKind } = accuracy.data;
  return (
    <div className='grid gap-2' data-testid='intake-accuracy'>
      <p className='text-sm'>
        Intake accuracy: {merged === 0 ? 'no merged globs with an intake decision yet' : `${corrected} of ${merged} merged globs had their category or type changed (${rate(corrected / merged)})`}
      </p>
      <p className='text-xs text-muted-foreground'>
        Intake is shown the most similar past globs, ones a person corrected first. {snapshots} globs recorded; older ones are rebuilt from their plans and
        say nothing about accuracy.
      </p>
      <JobStatus boardId={boardId} admin={admin} job='intake_outcome' />
      {merged > 0 && (
        <div className='grid gap-3 sm:grid-cols-2'>
          <table className='text-xs' data-testid='intake-accuracy-months'>
            <thead className='text-left text-muted-foreground'>
              <tr>
                <th className='pr-3 font-normal'>Created</th>
                <th className='pr-3 font-normal'>Merged</th>
                <th className='pr-3 font-normal'>Changed</th>
                <th className='font-normal'>Rate</th>
              </tr>
            </thead>
            <tbody>
              {[...byMonth, ...byPromptVersion.map((r) => ({ ...r, key: `prompt ${r.key}` }))].map((row) => (
                <tr key={row.key}>
                  <td className='pr-3'>{row.key}</td>
                  <td className='pr-3'>{row.merged}</td>
                  <td className='pr-3'>{row.corrected}</td>
                  <td>{rate(row.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className='text-xs' data-testid='intake-accuracy-kinds'>
            <thead className='text-left text-muted-foreground'>
              <tr>
                <th className='pr-3 font-normal'>Kind</th>
                <th className='pr-3 font-normal'>Merged</th>
                <th className='pr-3 font-normal'>Lines</th>
                <th className='pr-3 font-normal'>Hours</th>
                <th className='font-normal'>Review rounds</th>
              </tr>
            </thead>
            <tbody>
              {byKind.map((row) => (
                <tr key={row.key}>
                  <td className='pr-3'>{row.key}</td>
                  <td className='pr-3'>{row.merged}</td>
                  <td className='pr-3'>{median(row.medianChangedLines, '')}</td>
                  <td className='pr-3'>{median(row.medianCalendarHours, 'h')}</td>
                  <td>{median(row.medianReviewRounds, '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const SubLimit = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const limit = useQuery({ queryKey: ['sub-limit', boardId], queryFn: () => api.subLimit(boardId) });
  // The job's status (shared with its Run now): a finished run refetches the limit and its history.
  const jobs = useQuery({ queryKey: ['kb-jobs', boardId], queryFn: () => api.boardJobs(boardId) });
  const lastRun = jobs.data === undefined ? undefined : (jobs.data.find((j) => j.job === 'sub_limit')?.lastRunAt ?? null);
  // The run seen when the jobs first loaded: the limit was fetched after it, so only a later run refetches.
  const seenRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRun === undefined) return;
    if (seenRun.current !== undefined && seenRun.current !== lastRun)
      void client.invalidateQueries({ queryKey: ['sub-limit', boardId] });
    seenRun.current = lastRun;
  }, [client, boardId, lastRun]);
  if (limit.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the sub size limit.
        <Button size='sm' variant='outline' onClick={() => void limit.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (limit.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the sub size limit…</p>;
  const { current, bounds, history } = limit.data;
  return (
    <div className='grid gap-2' data-testid='sub-limit'>
      <p className='text-sm'>
        Sub size limit: {lines(current)} changed lines (learned from outcomes)
      </p>
      <p className='text-xs text-muted-foreground'>
        Subs changing more lines convert to sames. A converted sub that merges unchanged raises the limit; a sub that
        needed fixes after merging (a sign-off label asking for changes, or a bug report blaming it) lowers it. It stays
        between {lines(bounds.min)} and {lines(bounds.max)}, in steps of {bounds.step}.
      </p>
      <JobStatus boardId={boardId} admin={admin} job='sub_limit' />
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No outcomes recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Limit</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {history.map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {lines(change.fromLines)} → {lines(change.toLines)}
                </td>
                <td className='pr-3'>
                  {outcomeText(change)}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
                <td>
                  <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                    {change.globId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/**
 * How branch deploys run: none, CodeBuild (a project per environment, with a default) or GitHub
 * Actions (a workflow file). Either runs the repo's `.sstor/deploy.sh <env>`.
 */
const DeploySettings = ({
  deploy,
  environments,
  disabled,
  onChange,
}: {
  deploy: DeployIntegration | null;
  environments: readonly string[];
  disabled: boolean;
  onChange: (deploy: DeployIntegration | null) => void;
}) => (
  <div className='grid gap-2' data-testid='deploy-settings'>
    <h3 className='text-xs font-semibold text-muted-foreground'>Branch deploys</h3>
    <Label>
      Deploys run with
      <Select
        value={deploy?.provider ?? ''}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value === 'codebuild' ? CODEBUILD_DEFAULT : e.target.value === 'github_actions' ? GITHUB_DEFAULT : null)
        }
      >
        <option value=''>No deploys</option>
        <option value='codebuild'>AWS CodeBuild</option>
        <option value='github_actions'>GitHub Actions</option>
      </Select>
    </Label>
    {deploy?.provider === 'codebuild' && (
      <>
        <div className='grid grid-cols-2 gap-3'>
          <Label>
            Region
            <Input value={deploy.region} disabled={disabled} onChange={(e) => onChange({ ...deploy, region: e.target.value })} />
          </Label>
          <Label>
            Default project
            <Input
              value={deploy.defaultProject}
              disabled={disabled}
              onChange={(e) => onChange({ ...deploy, defaultProject: e.target.value })}
            />
          </Label>
        </div>
        {environments.map((env) => (
          <Label key={env}>
            Project for {env} (blank: the default)
            <Input
              value={deploy.projects[env] ?? ''}
              disabled={disabled}
              onChange={(e) => {
                const rest = Object.fromEntries(Object.entries(deploy.projects).filter(([name]) => name !== env));
                onChange({ ...deploy, projects: e.target.value.trim() === '' ? rest : { ...rest, [env]: e.target.value } });
              }}
            />
          </Label>
        ))}
        <p className='text-xs text-muted-foreground'>
          Each push to a glob with one of these environments starts the project at exactly that commit; it runs{' '}
          <code>.sstor/deploy.sh &lt;env&gt;</code>. Results come back through EventBridge.
        </p>
      </>
    )}
    {deploy?.provider === 'github_actions' && (
      <Label>
        Workflow file
        <Input value={deploy.workflow} disabled={disabled} onChange={(e) => onChange({ ...deploy, workflow: e.target.value })} />
      </Label>
    )}
  </div>
);

export const SignedOffPage = () => {
  const boardId = Number(useParams().boardId);
  usePageContext({ type: 'signed_off' });
  const pages = useInfiniteQuery({
    queryKey: ['signed-off', boardId],
    queryFn: ({ pageParam }) => api.signedOff(boardId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const globs = pages.data?.pages.flatMap((p) => p.globs) ?? [];
  const navigate = useNavigate();
  // A link to one glob (`?glob=<id>`) opens its page; the board page sends links here for globs no longer on it.
  const [searchParams] = useSearchParams();
  const linked = searchParams.get('glob');
  useEffect(() => {
    if (linked !== null) void navigate(`/boards/${String(boardId)}/globs/${encodeURIComponent(linked)}`, { replace: true });
  }, [linked, boardId, navigate]);

  return (
    <main className='mx-auto grid w-full max-w-[63rem] gap-4 p-6'>
      {globs.length === 0 && !pages.isLoading && <p className='text-sm text-muted-foreground'>Nothing signed off yet.</p>}
      {globs.map((g) => (
        <button
          key={g.id}
          type='button'
          // The list item has no actions; the glob page (fetched fresh) has them.
          onClick={() => void navigate(`/boards/${String(boardId)}/globs/${encodeURIComponent(g.id)}`)}
          className='flex items-center gap-2 rounded-md border bg-card p-2 text-left text-sm hover:bg-muted'
          data-testid={`signed-off-${g.id}`}
        >
          <span className='font-mono text-xs text-muted-foreground'>{g.id}</span>
          <span className='flex-1'>{g.title}</span>
          {g.group !== null && <GroupChip name={g.group} />}
          <span className='text-xs text-muted-foreground'>
            {g.signedOffAt === null ? '' : new Date(g.signedOffAt).toLocaleDateString()}
          </span>
        </button>
      ))}
      {pages.hasNextPage && (
        <Button variant='outline' onClick={() => void pages.fetchNextPage()}>
          Load more
        </Button>
      )}
    </main>
  );
};
