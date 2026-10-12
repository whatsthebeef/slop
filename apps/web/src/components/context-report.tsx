import type { ContextReport } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { JobStatus } from '@/components/job-status';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { changeText, CHOICE_SOURCE_TEXT, percentText, settingValueText, sourceTypeText, TIER_TEXT } from '@/lib/context-report';

const Heading = ({ children }: { children: string }) => <h4 className='mt-2 text-xs font-semibold text-muted-foreground'>{children}</h4>;

const Table = ({ head, rows, empty, testId }: { head: string[]; rows: (string | number)[][]; empty: string; testId: string }) =>
  rows.length === 0 ? (
    <p className='text-xs text-muted-foreground'>{empty}</p>
  ) : (
    <table className='text-xs' data-testid={testId}>
      <thead className='text-left text-muted-foreground'>
        <tr>
          {head.map((h) => (
            <th key={h} className='pr-3 font-normal'>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.join('|')}>
            {row.map((cell, i) => (
              <td key={head[i]} className='pr-3'>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

/**
 * The context report (System page): what agents were handed, what became of the choices, how the inbox's suggestions
 * fared, and the context settings with their defaults, effect and history. Settings are never edited by hand; an
 * admin can only put one back on its default. Everything is rendered as text.
 */
export const ContextSection = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const report = useQuery({ queryKey: ['context-report', boardId], queryFn: () => api.contextReport(boardId) });
  const reset = useMutation({
    mutationFn: (key: string) => api.resetContextSetting(boardId, key),
    onSuccess: () => client.invalidateQueries({ queryKey: ['context-report', boardId] }),
  });
  // The weekly run moves settings: reload when its last run changes.
  const jobs = useQuery({ queryKey: ['kb-jobs', boardId], queryFn: () => api.boardJobs(boardId) });
  const lastRun = jobs.data === undefined ? undefined : (jobs.data.find((j) => j.job === 'context_tuning')?.lastRunAt ?? null);
  const seenRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRun === undefined) return;
    if (seenRun.current !== undefined && seenRun.current !== lastRun) void client.invalidateQueries({ queryKey: ['context-report', boardId] });
    seenRun.current = lastRun;
  }, [client, boardId, lastRun]);

  if (report.isError)
    return (
      <p className='flex items-center gap-2 text-sm text-red'>
        Could not load the context report.
        <Button size='sm' variant='outline' onClick={() => void report.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (report.data === undefined) return <p className='text-sm text-muted-foreground'>Loading the context report…</p>;
  const r: ContextReport = report.data;
  const units = new Map(r.settings.map((s) => [s.key, s.unit]));
  const labels = new Map(r.settings.map((s) => [s.key, s.label]));
  return (
    <div className='grid gap-2' data-testid='context-report'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Context</h3>
      <p className='text-xs text-muted-foreground'>
        What agents are handed from the board's records, over the last {r.windowDays} days. Retrievals are counted from when slop started counting them by
        source; the most retrieved choices are counted from the start of the window.
      </p>

      <Heading>What agents get, by source</Heading>
      <Table
        testId='context-by-source'
        head={['Source', 'Retrievals', 'Share']}
        rows={r.retrievals.bySource.map((s) => [sourceTypeText(s.key), s.count, percentText(s.share)])}
        empty='No retrievals counted yet.'
      />
      <Heading>What agents get, by tier</Heading>
      <Table
        testId='context-by-tier'
        head={['Tier', 'Retrievals', 'Share']}
        rows={r.retrievals.byTier.map((t) => [TIER_TEXT[t.key], t.count, percentText(t.share)])}
        empty='No retrievals counted yet.'
      />

      <Heading>Most retrieved choices</Heading>
      {r.topRetrieved.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No choice has been retrieved yet.</p>
      ) : (
        <table className='text-xs' data-testid='context-top'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Choice</th>
              <th className='pr-3 font-normal'>From</th>
              <th className='pr-3 font-normal'>Returns</th>
              <th className='font-normal'>Globs behind it</th>
            </tr>
          </thead>
          <tbody>
            {r.topRetrieved.map((t) => (
              <tr key={t.decisionId} className='align-top'>
                <td className='pr-3'>{t.statement}</td>
                <td className='pr-3 whitespace-nowrap'>{CHOICE_SOURCE_TEXT[t.sourceKind]}</td>
                <td className='pr-3'>{t.returns}</td>
                <td>
                  {t.globs.map((g) => (
                    <Link key={g.id} className='mr-2 hover:underline' to={`/boards/${boardId}?glob=${encodeURIComponent(g.id)}`}>
                      {g.title}
                    </Link>
                  ))}
                  {t.globCount > t.globs.length && <span className='text-muted-foreground'>and {t.globCount - t.globs.length} more</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Heading>Choices</Heading>
      <Table
        testId='context-choices'
        head={['Measure', 'Count']}
        rows={[
          ['All choices', r.choices.total],
          ...r.choices.bySource.map((s): [string, number] => [`From ${CHOICE_SOURCE_TEXT[s.key].toLowerCase()} (${percentText(s.share)})`, s.count]),
          ['New this week', r.choices.newThisWeek],
          ['Replaced and applied automatically', r.choices.replaced.autoApplied],
          ['Replaced after a person confirmed', r.choices.replaced.confirmed],
          ['Replacement undone', r.choices.replaced.undone],
          [`Replacement cards confirmed (${r.windowDays} days)`, r.choices.cards.confirmed],
          [`Replacement cards dismissed (${r.windowDays} days)`, r.choices.cards.dismissed],
          [`Learnings raised from choices in use (${r.windowDays} days)`, r.choices.promoted.raised],
          [`Of those accepted (${r.windowDays} days)`, r.choices.promoted.accepted],
          [`Of those rejected (${r.windowDays} days)`, r.choices.promoted.rejected],
        ]}
        empty=''
      />

      <Heading>Conflicts with knowledge documents</Heading>
      {r.conflicts.length === 0 ? (
        <p className='text-xs text-muted-foreground' data-testid='context-conflicts'>
          None listed. {r.conflictsNote}
        </p>
      ) : (
        <Table
          testId='context-conflicts'
          head={['Choice', 'Document', 'Note']}
          rows={r.conflicts.map((c) => [c.statement, c.document, c.note])}
          empty=''
        />
      )}

      <Heading>Inbox</Heading>
      <Table
        testId='context-inbox'
        head={['Measure', 'Count']}
        rows={[
          [`Attached to a suggested glob (${r.windowDays} days)`, r.inbox.attachedViaSuggestion],
          [`Attached to another glob (${r.windowDays} days)`, r.inbox.attachedElsewhere],
          ['Kept', r.inbox.kept],
          ['Discarded', r.inbox.discarded],
        ]}
        empty=''
      />

      <Heading>Settings</Heading>
      <p className='text-xs text-muted-foreground'>
        Slop moves the learned ones a step at a time from what people did with the results; they are never set by hand.
        {admin ? ' You can put one back on its default.' : ' Admins can put one back on its default.'}
      </p>
      <table className='text-xs' data-testid='context-settings'>
        <thead className='text-left text-muted-foreground'>
          <tr>
            <th className='pr-3 font-normal'>Setting</th>
            <th className='pr-3 font-normal'>Value</th>
            <th className='pr-3 font-normal'>Default</th>
            <th className='pr-3 font-normal'>Bounds</th>
            <th className='font-normal' />
          </tr>
        </thead>
        <tbody>
          {r.settings.map((s) => (
            <tr key={s.key} className='align-top' data-testid={`context-setting-${s.key}`}>
              <td className='pr-3'>
                {s.label}
                <span className='block text-muted-foreground'>{s.effect}</span>
                {!s.learned && <span className='block text-muted-foreground'>Fixed: slop does not tune it.</span>}
              </td>
              <td className='pr-3 whitespace-nowrap'>{settingValueText(s.value, s.unit)}</td>
              <td className='pr-3 whitespace-nowrap'>{settingValueText(s.default, s.unit)}</td>
              <td className='pr-3 whitespace-nowrap'>{s.learned ? `${settingValueText(s.min, s.unit)} to ${settingValueText(s.max, s.unit)}` : '—'}</td>
              <td>
                {admin && s.learned && s.value !== s.default && (
                  <Button size='sm' variant='outline' disabled={reset.isPending} onClick={() => reset.mutate(s.key)}>
                    Reset to default
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {reset.isError && <p className='text-xs text-red'>Could not reset the setting.</p>}

      <Heading>Setting history</Heading>
      {r.history.length === 0 ? (
        <p className='text-xs text-muted-foreground'>No setting has moved yet.</p>
      ) : (
        <table className='text-xs' data-testid='context-history'>
          <thead className='text-left text-muted-foreground'>
            <tr>
              <th className='pr-3 font-normal'>Date</th>
              <th className='pr-3 font-normal'>Setting</th>
              <th className='pr-3 font-normal'>Change</th>
              <th className='font-normal'>Why</th>
            </tr>
          </thead>
          <tbody>
            {r.history.map((c) => (
              <tr key={c.id} className='align-top'>
                <td className='pr-3 whitespace-nowrap'>{new Date(c.at).toLocaleDateString()}</td>
                <td className='pr-3'>{labels.get(c.key) ?? c.key}</td>
                <td className='pr-3 whitespace-nowrap'>{changeText(c, units.get(c.key) ?? '')}</td>
                <td>{c.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <JobStatus boardId={boardId} admin={admin} job='context_tuning' />
    </div>
  );
};
