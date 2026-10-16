import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, RequestError } from '@/lib/api';
import { environmentHealth } from '@/lib/environment-health';
import { deploysKey } from '@/lib/live';
import { useToast } from '@/toast';

export const boardEnvironmentsKey = (boardId: number) => ['board-environments', boardId] as const;

/** Pick what a manual environment now runs: a branch, tag or commit (blank is the base branch's head), with recent tags offered. */
const RecordDeployForm = ({ boardId, environment, onDone }: { boardId: number; environment: string; onDone: () => void }) => {
  const client = useQueryClient();
  const toast = useToast();
  const [ref, setRef] = useState('');
  const tags = useQuery({ queryKey: ['release-tags', boardId], queryFn: () => api.releaseTags(boardId) });
  const record = useMutation({
    mutationFn: () => api.recordEnvironmentDeploy(boardId, environment, ref),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: boardEnvironmentsKey(boardId) });
      void client.invalidateQueries({ queryKey: deploysKey(boardId) });
      void client.invalidateQueries({ queryKey: ['glob-environments'] });
      toast(`Recorded the deploy to ${environment}`);
      onDone();
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not record the deploy'),
  });
  return (
    <form
      className='grid gap-2'
      data-testid='record-deploy-form'
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate();
      }}
    >
      <label className='grid gap-1 text-xs'>
        Branch, tag or commit
        <Input value={ref} placeholder='the base branch head' onChange={(e) => setRef(e.target.value)} />
      </label>
      {(tags.data ?? []).length > 0 && (
        <div className='flex flex-wrap gap-1' aria-label='Recent release tags'>
          {(tags.data ?? []).map((tag) => (
            <Button key={tag.name} type='button' variant='outline' size='sm' onClick={() => setRef(tag.name)}>
              {tag.name}
            </Button>
          ))}
        </div>
      )}
      <p className='text-xs text-muted-foreground'>
        Every glob in it gets {environment} on its card and its after-deploy steps fall due.
      </p>
      <Button type='submit' size='sm' disabled={record.isPending}>
        Record a deploy to {environment}
      </Button>
    </form>
  );
};

/** A "Record a deploy to <env>" button that opens the form; for manual environments, on the board and in settings. */
export const RecordDeployButton = ({ boardId, environment }: { boardId: number; environment: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' data-testid={`record-deploy-${environment}`}>
          Record a deploy
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-72' align='end'>
        <RecordDeployForm boardId={boardId} environment={environment} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
};

/**
 * The board header's environments: each observed environment with how its deploys are known and its last deploy, and for
 * a manual one a Record a deploy button. Nothing shows for a board without observed environments.
 */
export const BoardEnvironments = ({ boardId }: { boardId: number }) => {
  const query = useQuery({ queryKey: boardEnvironmentsKey(boardId), queryFn: () => api.boardEnvironments(boardId) });
  const environments = query.data ?? [];
  if (environments.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground'
          aria-label='Environments'
          title='Environments'
          data-testid='environments-toggle'
        >
          <Rocket className='h-4 w-4' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-96' align='end' data-testid='board-environments'>
        <ul className='grid gap-3'>
          {environments.map((env) => (
            <li key={env.environment} className='grid gap-1 text-xs' data-testid='board-environment'>
              <div className='flex items-center gap-2'>
                <span className='font-semibold'>{env.environment}</span>
                <span className='text-muted-foreground'>
                  {env.production ? 'production' : env.role} · {env.deployKnown === 'manual' ? 'recorded by hand' : 'reported by a pipeline'}
                </span>
                {env.deployKnown === 'manual' && (
                  <span className='ml-auto'>
                    <RecordDeployButton boardId={boardId} environment={env.environment} />
                  </span>
                )}
              </div>
              <p className='text-muted-foreground' data-testid='environment-health'>
                {environmentHealth(env)}
              </p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
};
