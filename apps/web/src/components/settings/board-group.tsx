import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ReadinessChecklist } from '@/components/readiness';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { BoardView } from '@/lib/api';
import { Field, SaveButton, SettingBlock, SettingsGroup } from './group';
import type { SettingsForm } from './form';

/** Which repository the board works in, and whether slop's GitHub App is installed on it. */
const RepositoryStatus = ({ boardId }: { boardId: number }) => {
  // Re-checked when the tab regains focus, so returning from GitHub's install page updates it.
  const connection = useQuery({
    queryKey: ['repo-connection', boardId],
    queryFn: () => api.repoConnection(boardId),
    refetchOnWindowFocus: true,
  });
  return (
    <SettingBlock title='Repository connection' hint="Whether slop's GitHub App can reach the repository below.">
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
    </SettingBlock>
  );
};

/** A link to `#readiness` opens the group and brings the checklist into view once it is on the page. */
const ScrollToReadiness = () => {
  useEffect(() => {
    document.getElementById('readiness')?.scrollIntoView({ block: 'start' });
  }, []);
  return null;
};

export const BoardGroup = ({
  board,
  admin,
  form,
  readinessLinked,
}: {
  board: BoardView;
  admin: boolean;
  form: SettingsForm;
  readinessLinked: boolean;
}) => (
  <SettingsGroup id='board' forceOpen={readinessLinked}>
    <RepositoryStatus boardId={board.id} />
    {readinessLinked && <ScrollToReadiness />}
    <ReadinessChecklist board={board} />
    <SettingBlock title='Board' hint='The basics every glob on this board is created from.'>
      <div className='grid gap-0.5' data-testid='board-name'>
        <span className='text-xs font-medium text-muted-foreground'>Board name</span>
        <p className='text-xs text-muted-foreground'>What this board is called in the board bar.</p>
        <p className='text-sm'>{board.name}</p>
      </div>
      <Field label='Repository (owner/name)' hint='The GitHub repository slop opens branches and pull requests in.'>
        {(props) => <Input {...props} value={form.repo} disabled={!admin} onChange={(e) => form.setRepo(e.target.value)} />}
      </Field>
      <Field label='Working-hours time zone' hint='Working hours (09:00–17:00 on weekdays) are counted in this zone.'>
        {(props) => <Input {...props} value={form.timeZone} disabled={!admin} onChange={(e) => form.setTimeZone(e.target.value)} />}
      </Field>
    </SettingBlock>
    <SaveButton visible={admin} pending={form.save.isPending} invalid={false} onSave={() => form.save.mutate()} />
  </SettingsGroup>
);
