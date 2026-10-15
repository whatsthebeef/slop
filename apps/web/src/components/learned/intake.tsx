import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { JobStatus } from '@/components/job-status';
import { api } from '@/lib/api';
import { newestFirst } from '@/lib/learned';
import { DefaultLine, Explainer, History, LoadFailed, LoadingText, PanelPart, ResetButton, Value } from './panel';

const rate = (value: number | null): string => (value === null ? '-' : `${Math.round(value * 100)}%`);
const median = (value: number | null, unit: string): string => (value === null ? '-' : `${Math.round(value * 10) / 10} ${unit}`);

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
  if (learning.isError) return <LoadFailed what='what intake learned about types' onRetry={() => void learning.refetch()} />;
  if (learning.data === undefined) return <LoadingText what='what intake learned about types' />;
  const learned = learning.data.learned === true;
  const corrections = learning.data.corrections ?? [];
  const defaults = learning.data.defaults ?? [];
  return (
    <PanelPart title='Types intake has learned' testId='type-learning'>
      <Value>
        {learned
          ? `Intake follows the latest ${corrections.length} ${corrections.length === 1 ? 'change' : 'changes'} people made to a type, with what the plan looked like, for similar requests.`
          : 'No one has changed a type yet, so intake uses the defaults.'}
      </Value>
      <DefaultLine testId='type-defaults'>
        Default:{' '}
        {defaults.length === 0
          ? 'intake decides without a rule of thumb.'
          : defaults.map((d, i) => (
              <span key={d.when}>
                {i > 0 && '; '}
                {d.type} for {d.when}
              </span>
            ))}
      </DefaultLine>
      <ResetButton admin={admin} show={learned} pending={reset.isPending} failed={reset.isError} failure='Could not reset what intake learned.' onClick={() => reset.mutate()} />
      <History testId='type-learning-history' count={corrections.length} empty='No type changes recorded yet.'>
        <ul className='grid gap-1 text-xs' data-testid='type-corrections'>
          {newestFirst(corrections).map((c) => (
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
      </History>
    </PanelPart>
  );
};

/**
 * How often intake's category and type survived to the merge (spec, Intake: learned task categorisation): by the month a glob
 * was created and by prompt version, with typical size, effort and review rounds by kind. Outcomes settle 14 days after a merge.
 */
const IntakeAccuracyView = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const accuracy = useQuery({ queryKey: ['intake-accuracy', boardId], queryFn: () => api.intakeAccuracy(boardId) });
  if (accuracy.isError) return <LoadFailed what='intake accuracy' onRetry={() => void accuracy.refetch()} />;
  if (accuracy.data === undefined) return <LoadingText what='intake accuracy' />;
  const { snapshots, merged, corrected, byMonth, byPromptVersion, byKind } = accuracy.data;
  // Months are keyed `YYYY-MM`: newest first by key; the prompt versions follow.
  const months = [...byMonth].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const prompts = byPromptVersion.map((r) => ({ ...r, key: `prompt ${r.key}` }));
  return (
    <PanelPart title='How often intake got it right' testId='intake-accuracy'>
      <Value>
        {merged === 0
          ? 'No merged globs with an intake decision yet.'
          : `${corrected} of ${merged} merged globs had their category or type changed (${rate(corrected / merged)}).`}
      </Value>
      <DefaultLine>Default: nothing to set. This is measured from outcomes, and settles 14 days after a merge.</DefaultLine>
      <Explainer>
        Intake is shown the most similar past globs, ones a person corrected first. {snapshots} globs recorded; older ones are rebuilt from their plans and
        say nothing about accuracy.
      </Explainer>
      <JobStatus boardId={boardId} admin={admin} job='intake_outcome' />
      {merged > 0 && (
        <>
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
          <History testId='intake-accuracy-history' count={months.length + prompts.length} noun={['period', 'periods']} empty=''>
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
                {[...months, ...prompts].map((row) => (
                  <tr key={row.key}>
                    <td className='pr-3'>{row.key}</td>
                    <td className='pr-3'>{row.merged}</td>
                    <td className='pr-3'>{row.corrected}</td>
                    <td>{rate(row.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </History>
        </>
      )}
    </PanelPart>
  );
};

/** The Intake panel's body: the types intake learned from people's changes, and how often its first choice held up. */
export const IntakePanel = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <>
    <TypeLearning boardId={boardId} admin={admin} />
    <IntakeAccuracyView boardId={boardId} admin={admin} />
  </>
);
