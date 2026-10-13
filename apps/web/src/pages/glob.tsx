import { describeEditFailure } from '@slop/core';
import type { Action, LabelCommand, LabelName } from '@slop/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ARTIFACT_META } from '@/components/artifacts';
import type { ArtifactRef } from '@/components/artifacts';
import { GlobDetail } from '@/components/glob-dialog';
import { ACTION_PATHS, api, RequestError } from '@/lib/api';
import type { GlobChanges, GlobView } from '@/lib/api';
import { withGlob } from '@/lib/glob-list';
import { labelToOpen, parseGlobTarget } from '@/lib/glob-section';
import { globKey, globsKey, useLiveBoard } from '@/lib/live';
import { usePageContext } from '@/lib/page-context';
import { useSstorCopy } from '@/components/sstor-notice';
import { mergeOutcomeText } from '@/lib/card-pending';
import { useToast } from '@/toast';

/** How often the glob is read again; the board's live hints refresh the cards, not this page's glob. */
const REFRESH_MS = 10_000;

/** One glob as a page in the main area, at its own URL (`/boards/:b/globs/:id`, `?artifact=<kind>` shows an artifact first). */
export const GlobPage = () => {
  const params = useParams();
  const boardId = Number(params.boardId);
  const globId = params.globId ?? '';
  const client = useQueryClient();
  const toast = useToast();
  const copyCommand = useSstorCopy();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  useLiveBoard(boardId);
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const glob = useQuery({ queryKey: globKey(globId), queryFn: () => api.glob(globId), refetchInterval: REFRESH_MS });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const view = glob.data;
  const state = view === undefined ? undefined : view.status === 'failed' || view.failure !== null ? 'failed' : view.status === 'signed_off' || view.pr?.state === 'merged' ? 'merged' : 'open';
  usePageContext({ type: 'glob', id: globId, ...(state === undefined ? {} : { state }), ...(view === undefined ? {} : { title: view.title }) });
  const target = parseGlobTarget(search);
  // Memoised: GlobDetail resets its selected artifact whenever this object changes, and the glob is read again every 10 s.
  const initialArtifact = useMemo((): ArtifactRef | null => {
    const kinds = Object.keys(ARTIFACT_META);
    const kind = kinds.find((k): k is ArtifactRef['kind'] => k === target.artifact);
    return kind === undefined ? null : { kind, label: target.label ?? '' };
  }, [target.artifact, target.label]);
  const toBoard = () => void navigate(`/boards/${String(boardId)}`);

  if (glob.data === undefined || board.data === undefined) {
    if (glob.error !== null) {
      return (
        <p className='p-6 text-sm' data-testid='glob-unavailable'>
          {glob.error instanceof RequestError ? glob.error.body.message : "The glob couldn't be loaded."}{' '}
          <Link className='underline' to={`/boards/${String(boardId)}`}>
            Back to the board
          </Link>
        </p>
      );
    }
    return <p className='p-6 text-muted-foreground'>Loading…</p>;
  }
  const open = glob.data;
  const store = (next: GlobView) => {
    client.setQueryData(globKey(next.id), next);
    client.setQueryData<GlobView[]>(globsKey(next.boardId), (list) => withGlob(list, next, next.boardId));
  };
  const viewerEmail = me.data?.email;
  const reload = async () => {
    store(await api.glob(open.id));
  };
  /** Runs a change; the page shows the glob as it is afterwards. False when it failed (the failure is shown). */
  const change = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await reload();
      return true;
    } catch (error) {
      if (error instanceof RequestError && error.body.current !== undefined) {
        await reload();
        toast(`${open.id} changed meanwhile; it has been refreshed.`);
      } else toast(error instanceof RequestError ? error.body.message : 'Something went wrong');
      return false;
    }
  };

  return (
    <GlobDetail
      board={board.data}
      glob={open}
      initialArtifact={initialArtifact}
      section={target.section}
      openLabel={labelToOpen(target)}
      onClose={toBoard}
      onAction={(action: Action, anyway?: boolean) => {
        const path = ACTION_PATHS[action];
        if (path === null) return Promise.resolve(false);
        // Copied before the request: browsers refuse clipboard writes once the click's user gesture has passed.
        const finish = copyCommand(action, open.id);
        return change(() => api.action(open.id, path, open.version, anyway)).then(async (ok) => {
          const after = client.getQueryData<GlobView>(globKey(open.id));
          const said = ok && after !== undefined ? mergeOutcomeText(action, after) : null;
          if (said !== null) toast(said);
          if (ok) await finish();
          return ok;
        });
      }}
      onReviewLabel={(label: LabelName, command: LabelCommand) => change(() => api.reviewLabel(open.id, label, command, open.version))}
      onDecide={(input) => change(() => api.decide(open.id, open.version, input))}
      onUpdate={async (changes: GlobChanges) => {
        try {
          store(await api.updateGlob(open.id, open.version, changes));
          return null;
        } catch (error) {
          // The view keeps the draft and shows why; a conflict is reloaded on request.
          return describeEditFailure(error instanceof RequestError ? error.body : { message: 'Something went wrong' });
        }
      }}
      onReload={reload}
      {...(viewerEmail === undefined ? {} : { email: viewerEmail })}
      onAddStep={(step) => change(() => api.addHumanStep(open.id, step))}
      onCompleteStep={(stepId) => change(() => api.completeHumanStep(open.id, stepId))}
      onDismissStep={(stepId, reason) => change(() => api.dismissHumanStep(open.id, stepId, reason))}
      onDelete={async () => {
        try {
          await api.deleteGlob(open.id, open.version);
          client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => list.filter((g) => g.id !== open.id));
          void client.invalidateQueries({ queryKey: ['signed-off', boardId] });
          toBoard();
        } catch (error) {
          toast(error instanceof RequestError ? error.body.message : 'Something went wrong');
        }
      }}
    />
  );
};
