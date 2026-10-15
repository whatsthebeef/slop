import { recentPeriods } from '@slop/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChatTestCases } from '@/components/chat-test-cases';
import { api, healthKey } from '@/lib/api';
import { capabilityRows } from '@/lib/capabilities';
import { useToast } from '@/toast';
import { message } from './form';
import { SettingBlock, SettingsGroup } from './group';

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
  // An older server without reports, or no access: say so instead of leaving the group empty.
  const timeZone = overview.data?.timeZone;
  if (timeZone === undefined)
    return <p className='text-sm text-muted-foreground'>{overview.isPending ? 'Loading…' : "The time report isn't available from this server."}</p>;
  // Reports are computed when downloaded, so any period that has begun can be offered; the running one counts up to now.
  const periods = recentPeriods(new Date().toISOString(), timeZone);
  return (
    <div className='grid gap-4' data-testid='time-reports'>
      <SettingBlock title='Working hours' hint="Time counts toward each person's active glob (one at a time, across every board) while it is in Doing.">
        <p className='text-sm'>
          09:00–17:00, weekdays, in <span className='font-mono'>{timeZone}</span>
        </p>
      </SettingBlock>
      <SettingBlock
        title='Time report (% R&D per developer)'
        hint="Only time on this board's globs counts; it is worked out from the event log when you download it, as CSV."
      >
        {overview.data?.canDownload === true ? (
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
        ) : (
          <p className='text-xs text-muted-foreground'>Only admins can download it.</p>
        )}
      </SettingBlock>
    </div>
  );
};

export const ReportsGroup = ({ boardId }: { boardId: number }) => (
  <SettingsGroup id='reports'>
    <TimeReports boardId={boardId} />
  </SettingsGroup>
);

const CAPABILITY_STATE_TEXT = { on: 'On', off: 'Off', unknown: 'Not reported' } as const;

/** What slop can verify about its own deployment; a human step with `check: <name>` is ticked once its capability is on. */
const SystemCapabilities = () => {
  const health = useQuery({ queryKey: healthKey, queryFn: api.health });
  return (
    <SettingBlock
      title='What the server can do'
      hint='Each line is something slop checked about its own deployment; it changes with how slop is set up, not here.'
      testId='system-capabilities'
    >
      {health.data === undefined ? (
        <p className='text-sm text-muted-foreground'>Loading…</p>
      ) : (
        <ul className='grid gap-1 text-sm'>
          {capabilityRows(health.data.capabilities).map((row) => (
            <li key={row.name} className='flex items-baseline gap-2' data-testid={`capability-${row.name}`}>
              <span className={row.state === 'on' ? 'font-medium' : 'text-muted-foreground'}>{CAPABILITY_STATE_TEXT[row.state]}</span>
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingBlock>
  );
};

export const SystemGroup = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <SettingsGroup id='system'>
    <SystemCapabilities />
    {admin && <ChatTestCases boardId={boardId} />}
  </SettingsGroup>
);
