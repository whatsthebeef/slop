import { EFFECT_CHECK_GLOBS_MAX, EFFECT_CHECK_GLOBS_MIN, ENVIRONMENT_ROLES, recentPeriods, ROLES } from '@slop/core';
import type { AgentKbApproval, DependencyCause, DeployIntegration, Environment, RiskAreaCause, Role, SizeOutcome, SubLimitChange } from '@slop/core';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { FILTER_TOGGLE_ID, FilterPane, FilterToggle, useBoardFilters } from '@/components/board-filter-pane';
import type { BoardShellContext } from '@/components/board-shell';
import { GlobCard } from '@/components/glob-card';
import { globPath } from '@/lib/glob-section';
import { ChatTestCases } from '@/components/chat-test-cases';
import { ContextSection } from '@/components/context-report';
import { JobStatus } from '@/components/job-status';
import { ReadinessChecklist } from '@/components/readiness';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { api, healthKey, RequestError } from '@/lib/api';
import { matchesFilters } from '@/lib/board-filters';
import { capabilityRows } from '@/lib/capabilities';
import { MAX_REVIEW_TOOL_CAP, REVIEW_SEVERITY_CHOICES, reviewFormOf, reviewSettingsOfForm, toolCapInvalid } from '@/lib/review-settings';
import type { ReviewForm } from '@/lib/review-settings';
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
  const [autoInvestigate, setAutoInvestigate] = useState(true);
  const [review, setReview] = useState<ReviewForm>(reviewFormOf({ enabled: true, model: null, minSeverity: 'medium', ignoredPaths: [], toolCap: null }));

  useEffect(() => {
    if (board.data === undefined) return;
    setEnvs([...board.data.environments]);
    setTimeZone(board.data.timeZone);
    setBaseBranch(board.data.baseBranch);
    setRepo(board.data.repo ?? '');
    setDeploy(board.data.deploy);
    setEffectCheckGlobs(String(board.data.effectCheckGlobs));
    setAgentKbApproval(board.data.agentKbApproval);
    setAutoInvestigate(board.data.autoInvestigate);
    setReview(reviewFormOf(board.data.review));
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
        autoInvestigate,
        review: reviewSettingsOfForm(review),
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
        <label className='flex items-center gap-2 text-sm' title='A glob in Planning that intake flags as big gets a routine run that investigates it (no branch, no commits)'>
          <input
            type='checkbox'
            disabled={!admin}
            checked={autoInvestigate}
            onChange={(e) => setAutoInvestigate(e.target.checked)}
            data-testid='auto-investigate'
          />
          Investigate big globs in Planning automatically
        </label>
        <h3 className='text-xs font-semibold text-muted-foreground'>Independent review</h3>
        <label className='flex items-center gap-2 text-sm' title='Off stops the automatic reviews; Review code on a glob still works'>
          <input
            type='checkbox'
            disabled={!admin}
            checked={review.enabled}
            onChange={(e) => setReview({ ...review, enabled: e.target.checked })}
            data-testid='review-enabled'
          />
          Review changes automatically
        </label>
        <Label>
          Reviewer model (a Bedrock model ID; blank for the server's default)
          <Input
            value={review.model}
            placeholder='Server default'
            disabled={!admin}
            onChange={(e) => setReview({ ...review, model: e.target.value })}
            data-testid='review-model'
          />
        </Label>
        <Label>
          Comment on GitHub from this severity up (lower ones are listed in the review's summary)
          <Select
            className='w-32'
            value={review.minSeverity}
            disabled={!admin}
            onChange={(e) => {
              const severity = REVIEW_SEVERITY_CHOICES.find((s) => s === e.target.value);
              if (severity !== undefined) setReview({ ...review, minSeverity: severity });
            }}
            data-testid='review-min-severity'
          >
            {REVIEW_SEVERITY_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Paths the reviewer skips, one glob per line (on top of the merge policy's size-ignored paths)
          <textarea
            className='min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs'
            value={review.ignoredPaths}
            disabled={!admin}
            onChange={(e) => setReview({ ...review, ignoredPaths: e.target.value })}
            data-testid='review-ignored-paths'
          />
        </Label>
        <Label>
          Reviewer tool calls per review (1–{MAX_REVIEW_TOOL_CAP}; blank for the default)
          <Input
            type='number'
            min={1}
            max={MAX_REVIEW_TOOL_CAP}
            step={1}
            className='w-24'
            value={review.toolCap}
            disabled={!admin}
            onChange={(e) => setReview({ ...review, toolCap: e.target.value })}
            aria-invalid={toolCapInvalid(review)}
            data-testid='review-tool-cap'
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
        <KnowledgeJobs boardId={boardId} admin={admin} />
        <SubLimit boardId={boardId} admin={admin} />
        <DependencyRules boardId={boardId} admin={admin} />
        <RiskAreas boardId={boardId} admin={admin} />
        <TypeLearning boardId={boardId} admin={admin} />
        <Escalations boardId={boardId} admin={admin} />
        <SizeThreshold boardId={boardId} admin={admin} />
        <SizeCalibrationView boardId={boardId} />
        <ContextSection boardId={boardId} admin={admin} />
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
            <Button size='sm' disabled={save.isPending || toolCapInvalid(review)} onClick={() => save.mutate()}>
              Save settings
            </Button>
          </div>
        )}
      </section>

      <TimeReports boardId={boardId} />

      <SystemCapabilities />

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
      {admin && <ChatTestCases boardId={boardId} />}
    </main>
  );
};

const CODEBUILD_DEFAULT: DeployIntegration = { provider: 'codebuild', region: 'us-east-1', defaultProject: '', projects: {} };
const GITHUB_DEFAULT: DeployIntegration = { provider: 'github_actions', workflow: 'slop-deploy.yml' };

/** The board's self-improvement jobs over its learnings: when each last ran and what it did, with Run now for admins. */
const KnowledgeJobs = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <div className='grid gap-1' data-testid='kb-jobs'>
    <h3 className='text-xs font-semibold text-muted-foreground'>Learning jobs</h3>
    <p className='text-xs text-muted-foreground'>
      Each week slop mines its own data for signals worth a learning, merges open learnings that state the same fact (only on
      quotes it checks) and flags stale ones; each day it checks whether approved changes with a signal worked, and proposes
      revising or reverting one that didn't. What they raise shows on the board as decisions.
    </p>
    <JobStatus boardId={boardId} admin={admin} job='mining' />
    <JobStatus boardId={boardId} admin={admin} job='consolidation' />
    <JobStatus boardId={boardId} admin={admin} job='effect_check' />
  </div>
);

const lines = (n: number) => n.toLocaleString('en');

/** A sub's changed lines; unknown when neither its gate verdict nor its merge commit gave a count. */
const changed = (n: number | null) => (n === null ? 'line count unknown' : `${lines(n)} lines`);

/** Why an outcome moved the limit, in words. */
const outcomeText = (change: Pick<SubLimitChange, 'outcome' | 'changedLines'>): string =>
  change.outcome === 'merged_unchanged'
    ? `Converted for its size (${changed(change.changedLines)}) and merged unchanged`
    : `Passed the gate (${changed(change.changedLines)}) and needed fixes after merging`;

/**
 * The learned sub size limit: read-only (slop moves it with outcomes), with its history. Every value is rendered as
 * text, including the evidence quotes, which come from labels' checklists and bug reports.
 */
const SIZE_OUTCOME_TEXT: Partial<Record<SizeOutcome, string>> = {
  kept_whole_clean: 'Flagged and merged cleanly: raised',
  unflagged_struggled: 'Not flagged, and it struggled: lowered',
  flag_confirmed: 'Flag confirmed: unchanged',
  reset: 'Reset to the defaults',
};

/**
 * The learned size threshold (oversized flag): read-only, with its history. Evidence is rendered as text.
 */
const SizeThreshold = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const threshold = useQuery({ queryKey: ['size-threshold', boardId], queryFn: () => api.sizeThreshold(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetSizeThreshold(boardId),
    onSuccess: (view) => client.setQueryData(['size-threshold', boardId], view),
  });
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
  const { current, defaults, bounds, history } = threshold.data;
  const learned = defaults.maxTasks !== current.maxTasks || defaults.maxParts !== current.maxParts;
  return (
    <div className='grid gap-2' data-testid='size-threshold'>
      <p className='text-sm'>
        Oversized threshold: more than {current.maxTasks} tasks or {current.maxParts} independent parts ({learned ? 'learned from outcomes' : 'the default'})
      </p>
      <p className='text-xs text-muted-foreground' data-testid='size-threshold-forecast'>
        Judged from the code (the forecast), the part limit is {Math.max(current.maxParts, 3)} or more separate modules, and only when at least 2 of them can be built at the same time.
      </p>
      <p className='text-xs text-muted-foreground' data-testid='size-threshold-defaults'>
        Default: {defaults.maxTasks} tasks, {defaults.maxParts} independent parts. Learned: {current.maxTasks} tasks, {current.maxParts} independent parts.
      </p>
      {admin && learned && (
        <div>
          <Button size='sm' variant='outline' disabled={reset.isPending} onClick={() => reset.mutate()}>
            Reset to defaults
          </Button>
          {reset.isError && <span className='ml-2 text-xs text-red'>Could not reset the size threshold.</span>}
        </div>
      )}
      <p className='text-xs text-muted-foreground'>
        Intake flags a glob above it, and only when at least two of its parts could be built at the same time (a long serial plan stays whole), and
        advises with its size workstreams and critical path. A flagged glob that merges cleanly raises the threshold. An unflagged glob that struggles (the most review rounds, a failed run or a very long PR) lowers it.
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
                  {SIZE_OUTCOME_TEXT[change.outcome] ?? 'Earlier outcome (no longer recorded)'}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
                <td>
                  {change.outcome === 'reset' ? null : (
                    <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                      {change.globId}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/** The size forecast's calibration: read-only, learned values against the defaults, with the history and its causes as text. */
const SizeCalibrationView = ({ boardId }: { boardId: number }) => {
  const calibration = useQuery({ queryKey: ['size-calibration', boardId], queryFn: () => api.sizeCalibration(boardId) });
  if (calibration.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the size calibration.
        <Button size='sm' variant='outline' onClick={() => void calibration.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (calibration.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the size calibration…</p>;
  const { current, defaults, history } = calibration.data;
  const areas = Object.entries(current.areaFactors);
  const defaultFactor = (area: string): number => Object.entries(defaults.areaFactors).find(([name]) => name === area)?.[1] ?? 1;
  const learned = (now: number, start: number) => (now === start ? 'default' : `learned, default ${start}`);
  return (
    <div className='grid gap-2' data-testid='size-calibration'>
      <p className='text-sm'>Size forecast calibration ({current.samples} merged globs learned from)</p>
      <p className='text-xs text-muted-foreground'>
        The forecast blends three signals: the code, similar past globs and the plan text. Merged globs move the weights toward the signal that was closest
        and each area's factor toward the lines the area really took.
      </p>
      <ul className='text-xs'>
        <li>
          Code weight {current.weights.code} ({learned(current.weights.code, defaults.weights.code)})
        </li>
        <li>
          Similar globs weight {current.weights.reference} ({learned(current.weights.reference, defaults.weights.reference)})
        </li>
        <li>
          Text weight {current.weights.text} ({learned(current.weights.text, defaults.weights.text)})
        </li>
        {areas.length === 0 ? (
          <li className='text-muted-foreground'>No area corrections yet.</li>
        ) : (
          areas.map(([area, factor]) => (
            <li key={area}>
              {area} lines x{factor} ({learned(factor, defaultFactor(area))})
            </li>
          ))
        )}
      </ul>
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No calibration moves recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>What</th>
              <th className='pr-3 font-normal'>Why</th>
              <th className='font-normal'>Glob</th>
            </tr>
          </thead>
          <tbody>
            {history.map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 whitespace-nowrap'>{change.kind === 'weights' ? 'weights' : `${change.area ?? 'area'} factor`}</td>
                <td className='pr-3'>{change.cause}</td>
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

const CAPABILITY_STATE_TEXT = { on: 'On', off: 'Off', unknown: 'Not reported' } as const;

/** What slop can verify about its own deployment; a human step with `check: <name>` is ticked once its capability is on. */
const SystemCapabilities = () => {
  const health = useQuery({ queryKey: healthKey, queryFn: api.health });
  if (health.data === undefined) return null;
  return (
    <section className='grid gap-2' data-testid='system-capabilities'>
      <h2 className='text-sm font-semibold'>System</h2>
      <ul className='grid gap-1 text-sm'>
        {capabilityRows(health.data.capabilities).map((row) => (
          <li key={row.name} className='flex items-baseline gap-2' data-testid={`capability-${row.name}`}>
            <span className={row.state === 'on' ? 'font-medium' : 'text-muted-foreground'}>{CAPABILITY_STATE_TEXT[row.state]}</span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
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
        between {lines(bounds.min)} and {lines(bounds.max)}. The step starts at {lines(bounds.startStep ?? 500)} lines, grows by half while
        outcomes keep the same direction and halves when one reverses; it is {lines(bounds.step)} now. A small sub that
        needed fixes leaves the limit alone and counts for the risk areas below.
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
              <th className='pr-3 font-normal'>Step</th>
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
                <td className='pr-3 whitespace-nowrap'>{change.step === undefined ? '' : lines(change.step)}</td>
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

const DEPENDENCY_CAUSE_TEXT: Record<DependencyCause, string> = {
  clean_overlap: 'Globs predicted to share files merged with no conflict or rework',
  conflicted_overlap: 'Globs predicted to share files conflicted or needed a rebase',
  unmerged_prerequisite: 'A run failed because a prerequisite was not merged',
  start_anyway_succeeded: 'A relation was started anyway and merged without it',
  edge_dismissed: 'A person dismissed an inferred relation as wrong',
  reset: 'An admin reset the rule',
};

/**
 * The path patterns the board predicts shared files from (a prediction never holds a start), each with the
 * catalog default and what the board learned from outcomes. Admins reset a rule to its default. Everything is rendered as text.
 */
const DependencyRules = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ['dependency-rules', boardId], queryFn: () => api.dependencyRules(boardId) });
  const reset = useMutation({
    mutationFn: (pattern: string | undefined) => api.resetDependencyRules(boardId, pattern),
    onSuccess: () => client.invalidateQueries({ queryKey: ['dependency-rules', boardId] }),
  });
  if (rules.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the dependency rules.
        <Button size='sm' variant='outline' onClick={() => void rules.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (rules.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the dependency rules…</p>;
  const { rules: list, history, predictMin } = rules.data;
  return (
    <div className='grid gap-2' data-testid='dependency-rules'>
      <p className='text-xs text-muted-foreground'>
        Slop predicts from these path patterns which globs may change the same files, to warn about conflicts and order merges. A
        prediction never holds a glob back: a glob waits for another only through a relation (a need, a decision or a split part).
        A pattern whose predictions merged cleanly is weakened and stops being used below {predictMin}; one that conflicted is
        strengthened. A run that failed for unmerged prerequisites teaches the board a relation.
      </p>
      {list.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No patterns yet: set exclusive paths in the merge policy.</p>
      ) : (
        <ul className='grid gap-1 text-xs'>
          {list.map((rule) => (
            <li key={rule.pattern}>
              <span className='font-mono'>{rule.pattern}</span>{' '}
              <span className='text-muted-foreground'>
                weight {rule.weight} ({rule.state === 'learned' ? `learned, default ${rule.defaultWeight}` : 'default'};{' '}
                {rule.predicted ? 'predicted' : 'not predicted'}; clean {rule.cleanCount}, conflicts {rule.conflictCount})
              </span>
              {admin && rule.state === 'learned' && (
                <Button size='sm' variant='outline' className='ml-2' disabled={reset.isPending} onClick={() => reset.mutate(rule.pattern)}>
                  Reset
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reset.isError && <span className='text-xs text-red'>Could not reset the rule.</span>}
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No changes recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Pattern</th>
              <th className='pr-3 font-normal'>Weight</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {history.map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3 font-mono'>{change.pattern}</td>
                <td className='pr-3 whitespace-nowrap'>
                  {change.from} → {change.to}
                </td>
                <td>
                  {DEPENDENCY_CAUSE_TEXT[change.cause]}
                  {change.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                        {change.globId}
                      </Link>
                    </>
                  )}
                  <span className='block text-muted-foreground'>{change.evidence}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const RISK_CAUSE_TEXT: Record<RiskAreaCause, string> = {
  reverted: 'A sub that changed it was reverted',
  bug: 'A bug blamed a sub that changed it',
  deploy_failed: 'A deploy failed after a sub changed it',
  blocked: 'A person blocked a sub that changed it at auto-merge',
  small_fix: 'A small sub that changed it needed fixes',
  clean: 'Subs that changed it were clean',
  type_to_same: 'A person changed intake\'s sub to same',
  type_to_sub: 'A person changed intake\'s same to sub',
  reset: 'An admin reset or removed areas',
  cleanup: 'Slop dropped it: too wide, or fewer than two globs of evidence',
};

/**
 * The board's risk areas: work that intake sends to a person's review (type same). Defaults and learned ones, with the
 * history of what changed them and why. Admins reset them to the defaults. Everything is rendered as text.
 */
const RiskAreas = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const areas = useQuery({ queryKey: ['risk-areas', boardId], queryFn: () => api.riskAreas(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetRiskAreas(boardId),
    onSuccess: (view) => client.setQueryData(['risk-areas', boardId], view),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.removeRiskArea(boardId, name),
    onSuccess: (view) => client.setQueryData(['risk-areas', boardId], view),
  });
  if (areas.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the risk areas.
        <Button size='sm' variant='outline' onClick={() => void areas.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (areas.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the risk areas…</p>;
  const { areas: list, history } = areas.data;
  return (
    <div className='grid gap-2' data-testid='risk-areas'>
      <p className='text-xs text-muted-foreground'>
        Intake chooses sub unless the work matches one of these areas (or is beyond the sub size). Slop adds an area when a
        sub that changed those paths was reverted, blamed by a bug, failed a deploy or needed fixes while small, or when a
        person changes intake's type, but only for a narrow module or file and only after two separate globs show it. Repeated clean subs remove a learned area.
      </p>
      <ul className='grid gap-1 text-xs'>
        {list.map((area) => (
          <li key={area.name}>
            <span className='font-medium'>{area.name}</span>{' '}
            <span className='text-muted-foreground'>
              ({area.source}
              {area.subSafe ? ', recent subs were clean' : ''}; strength {area.strength}, clean {area.cleanCount})
            </span>
            <span className='block text-muted-foreground'>{area.pathPatterns.join(', ')}</span>
            <span className='block text-muted-foreground'>{area.why}</span>
            {area.source === 'learned' && (
              <span className='block text-muted-foreground'>
                Evidence:{' '}
                {area.evidence.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ', '}
                    <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(id)}`}>
                      {id}
                    </Link>
                  </span>
                ))}
                {admin && (
                  <Button size='sm' variant='outline' className='ml-2' disabled={remove.isPending} onClick={() => remove.mutate(area.name)}>
                    Remove
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <div>
          <Button size='sm' variant='outline' disabled={reset.isPending} onClick={() => reset.mutate()}>
            Reset to defaults
          </Button>
          {reset.isError && <span className='ml-2 text-xs text-red'>Could not reset the risk areas.</span>}
        </div>
      )}
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No changes recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Area</th>
              <th className='pr-3 font-normal'>Change</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {history.map((change) => (
              <tr key={change.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(change.at).toLocaleDateString()}</td>
                <td className='pr-3'>{change.areaName ?? 'no known paths'}</td>
                <td className='pr-3 whitespace-nowrap'>{change.kind}</td>
                <td>
                  {RISK_CAUSE_TEXT[change.cause]}
                  {change.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(change.globId)}`}>
                        {change.globId}
                      </Link>
                    </>
                  )}
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
 * What intake learned about types from people's retypes (sub, same, super): the board's recent corrections, or the
 * catalog defaults while it has none. Admins reset it; the corrections stay as history. Everything is rendered as text.
 */
const TypeLearning = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const learning = useQuery({ queryKey: ['type-learning', boardId], queryFn: () => api.typeLearning(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetTypeLearning(boardId),
    onSuccess: (view) => client.setQueryData(['type-learning', boardId], view),
  });
  if (learning.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load what intake learned about types.
        <Button size='sm' variant='outline' onClick={() => void learning.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (learning.data === undefined) return <p className='text-sm text-muted-foreground'>Loading what intake learned about types…</p>;
  const learned = learning.data.learned === true;
  const corrections = learning.data.corrections ?? [];
  const defaults = learning.data.defaults ?? [];
  return (
    <div className='grid gap-2' data-testid='type-learning'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Types intake learned</h3>
      <p className='text-xs text-muted-foreground'>
        {learned
          ? "Intake is shown the latest changes people made to a type, with what the plan looked like, and follows them for similar requests."
          : 'No one has changed a type yet, so intake uses the defaults.'}
      </p>
      {learned ? (
        <ul className='grid gap-1 text-xs' data-testid='type-corrections'>
          {corrections.map((c) => (
            <li key={c.id}>
              <span className='font-medium'>
                {c.fromType} to {c.toType}
              </span>{' '}
              <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(c.globId)}`}>
                {c.globId}
              </Link>{' '}
              <span className='text-muted-foreground'>
                by {c.actor}, {new Date(c.at).toLocaleDateString()}
              </span>
              <span className='block text-muted-foreground'>
                {c.signals.openQuestions} open questions, {c.signals.decisionWording ? 'decision wording' : 'no decision wording'},{' '}
                {c.signals.riskAreaFiles.length} risk-area files, {c.signals.sizeTasks ?? 'no'} tasks
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className='grid gap-1 text-xs' data-testid='type-defaults'>
          {defaults.map((d) => (
            <li key={d.when}>
              <span className='font-medium'>{d.type}</span> <span className='text-muted-foreground'>for {d.when}</span>
            </li>
          ))}
        </ul>
      )}
      {admin && learned && (
        <div>
          <Button size='sm' variant='outline' disabled={reset.isPending} onClick={() => reset.mutate()}>
            Reset to defaults
          </Button>
          {reset.isError && <span className='ml-2 text-xs text-red'>Could not reset what intake learned.</span>}
        </div>
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

const noop = () => undefined;

export const SignedOffPage = () => {
  const boardId = Number(useParams().boardId);
  usePageContext({ type: 'signed_off' });
  const pages = useInfiniteQuery({
    queryKey: ['signed-off', boardId],
    queryFn: ({ pageParam }) => api.signedOff(boardId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  // The same filter pane and matching as the board; they apply to the globs loaded so far.
  const { headerActions } = useOutletContext<BoardShellContext>();
  const { filters, filtering, setFilters, filterOpen, setFilterOpen } = useBoardFilters(boardId);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 30_000 });
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const viewer = me.data === undefined || board.data === undefined ? undefined : { email: me.data.email, role: board.data.role };
  const loaded = pages.data?.pages.flatMap((p) => p.globs) ?? [];
  const now = new Date().toISOString();
  const globs = loaded.filter((g) => matchesFilters(g, filters, { now, viewer }));
  const navigate = useNavigate();
  // A link to one glob (`?glob=<id>`) opens its page; the board page sends links here for globs no longer on it.
  const [searchParams] = useSearchParams();
  const linked = searchParams.get('glob');
  useEffect(() => {
    if (linked !== null) void navigate(`/boards/${String(boardId)}/globs/${encodeURIComponent(linked)}`, { replace: true });
  }, [linked, boardId, navigate]);

  return (
    <main className='mx-auto grid w-full max-w-[90rem] gap-4 p-6'>
      {headerActions !== null &&
        createPortal(<FilterToggle open={filterOpen} active={filtering} onClick={() => setFilterOpen(!filterOpen)} />, headerActions)}
      <FilterPane
        open={filterOpen}
        values={filters}
        onChange={setFilters}
        onClose={() => {
          setFilterOpen(false);
          document.getElementById(FILTER_TOGGLE_ID)?.focus();
        }}
      />
      {globs.length === 0 && !pages.isLoading && (
        <p className='text-sm text-muted-foreground' data-testid='no-match'>
          {loaded.length === 0 ? 'Nothing signed off yet.' : 'No globs match the filter'}
        </p>
      )}
      {globs.length > 0 && (
        <div className='grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]' data-testid='signed-off-grid'>
          {globs.map((g) => (
            <div key={g.id} className='contents' data-testid={`signed-off-${g.id}`}>
              {/* Read-only: no moves, actions or label changes; the glob page (fetched fresh) has them. */}
              <GlobCard
                glob={g}
                onOpen={() => void navigate(globPath(boardId, g.id))}
                onOpenSection={(target) => void navigate(globPath(boardId, g.id, target))}
                onFilterGroup={(name) => {
                  setFilters({ ...filters, group: name });
                  setFilterOpen(true);
                }}
                moves={[]}
                previewing={null}
                onPreview={noop}
                onMove={noop}
                onArrow={noop}
                viewer={viewer}
              />
            </div>
          ))}
        </div>
      )}
      {pages.hasNextPage && (
        <Button variant='outline' onClick={() => void pages.fetchNextPage()}>
          Load more
        </Button>
      )}
    </main>
  );
};

const STANCE_TEXT = { loosened: 'learned: loosened', default: 'default', strengthened: 'learned: strengthened' } as const;

/**
 * The board's escalation criteria and what slop learned from their outcomes: an escalation approved unchanged loosens
 * its criterion, one that got changes (or a sub that merged and was reverted or blamed) strengthens it. Admins reset
 * the criteria to the defaults; the history stays. Everything is rendered as text.
 */
const Escalations = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const view = useQuery({ queryKey: ['escalations', boardId], queryFn: () => api.escalations(boardId) });
  const reset = useMutation({
    mutationFn: () => api.resetEscalations(boardId),
    onSuccess: (data) => client.setQueryData(['escalations', boardId], data),
  });
  if (view.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the escalation history.
        <Button size='sm' variant='outline' onClick={() => void view.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (view.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the escalation history…</p>;
  const { criteria, history } = view.data;
  return (
    <div className='grid gap-2' data-testid='escalations'>
      <h3 className='text-sm font-medium'>Escalation criteria</h3>
      <p className='text-xs text-muted-foreground'>
        Agents escalate a sub to a same when a person should check it. Slop records each escalation and its outcome: approved
        unchanged loosens its criterion; changes asked for, or a revert, strengthens it; a sub that merged unescalated and was
        reverted or blamed by a bug counts against the criterion it should have met. A change of stance is proposed as a
        learning for the agents' guidance.
      </p>
      <ul className='grid gap-1 text-xs'>
        {criteria.map((c) => (
          <li key={c.criterion}>
            <span className='font-medium'>{c.text}</span>{' '}
            <span className='text-muted-foreground'>
              ({STANCE_TEXT[c.stance]}; score {c.score}; unnecessary {c.unnecessary}, justified {c.justified}, missed {c.missed})
            </span>
          </li>
        ))}
      </ul>
      {admin && (
        <div>
          <Button size='sm' variant='outline' disabled={reset.isPending} onClick={() => reset.mutate()}>
            Reset to defaults
          </Button>
          {reset.isError && <span className='ml-2 text-xs text-red'>Could not reset the escalation criteria.</span>}
        </div>
      )}
      {history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No escalation outcomes recorded yet.</p>
      ) : (
        <table className='text-xs'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Criterion</th>
              <th className='pr-3 font-normal'>Outcome</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(r.at).toLocaleDateString()}</td>
                <td className='pr-3'>{r.outcome === 'reset' ? '' : r.criterion}</td>
                <td className='pr-3 whitespace-nowrap'>{r.outcome}</td>
                <td>
                  {r.cause}
                  {r.globId !== null && (
                    <>
                      {' '}
                      <Link className='hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(r.globId)}`}>
                        {r.globId}
                      </Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
