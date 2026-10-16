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
import { groupNames } from '@/lib/group-names';
import { withGlob } from '@/lib/glob-list';
import { labelToOpen, parseGlobTarget } from '@/lib/glob-section';
import { globKey, globsKey, useLiveBoard } from '@/lib/live';
import { usePageContext } from '@/lib/page-context';
import { useSstorCopy } from '@/components/sstor-notice';
import { mergeOutcomeText, outcomeRecorded } from '@/lib/click-outcome';
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
  const boardGlobs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });
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
  /**
   * Runs a change; the page shows the glob as it is afterwards. False when it failed (the failure is shown). A click the machine
   * refused is stored on the glob as its last outcome (which bumps the version): the page reloads it and the notice says why, so
   * only a failure with nothing stored is toasted.
   */
  const change = async (work: () => Promise<unknown>, clicked?: Action): Promise<boolean> => {
    try {
      await work();
      await reload();
      return true;
    } catch (error) {
      if (error instanceof RequestError && error.body.current !== undefined) {
        await reload();
        toast(`${open.id} changed meanwhile; it has been refreshed.`);
      } else if (error instanceof RequestError && clicked !== undefined) {
        const fresh = await api.glob(open.id).catch(() => null);
        if (fresh !== null) store(fresh);
        if (fresh === null || !outcomeRecorded(fresh, open, clicked)) toast(error.body.message);
      } else toast(error instanceof RequestError ? error.body.message : 'Something went wrong');
      return false;
    }
  };

  return (
    <GlobDetail
      board={board.data}
      glob={open}
      groups={groupNames(boardGlobs.data ?? [])}
      initialArtifact={initialArtifact}
      section={target.section}
      openLabel={labelToOpen(target)}
      onClose={toBoard}
      onAction={(action: Action, anyway?: boolean, text?: string) => {
        // An action glob's Done and Dismiss carry what the person typed: a note, or the reason.
        if (action === 'complete_action') return change(() => api.completeAction(open.id, open.version, text));
        if (action === 'fail_action') return change(() => api.failAction(open.id, open.version, text ?? ''));
        if (action === 'dismiss_action') return change(() => api.dismissAction(open.id, open.version, text ?? ''));
        const path = ACTION_PATHS[action];
        if (path === null) return Promise.resolve(false);
        // Copied before the request: browsers refuse clipboard writes once the click's user gesture has passed.
        const finish = copyCommand(action, open.id, open.type);
        // Start now, Merge anyway and Sign off anyway carry the reason typed in their confirmation.
        const reason = action === 'start_anyway' || action === 'merge_anyway' || action === 'sign_off_anyway' ? text : undefined;
        return change(() => api.action(open.id, path, open.version, anyway, reason), action).then(async (ok) => {
          const after = client.getQueryData<GlobView>(globKey(open.id));
          const said = ok && after !== undefined ? mergeOutcomeText(action, after) : null;
          if (said !== null) toast(said);
          if (ok) await finish();
          return ok;
        });
      }}
      onReviewLabel={(label: LabelName, command: LabelCommand) => change(() => api.reviewLabel(open.id, label, command, open.version))}
      onDismissEdge={(relationId: string) => change(() => api.dismissRelation(open.id, relationId, open.version))}
      onAddRelation={(input) => change(() => api.addRelation(open.id, input))}
      onPromoteRelation={(relationId: string) => change(() => api.promoteRelation(open.id, relationId, open.version))}
      onAnswerQuestion={(questionId, input) => change(() => api.answerQuestion(open.id, questionId, input))}
      onDismissQuestion={(questionId, note) => change(() => api.dismissQuestion(open.id, questionId, note))}
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
      onMarkDeployed={(env) => change(() => api.markEnvironmentDeployed(open.id, env))}
      onDismissStep={(stepId, reason) => change(() => api.dismissHumanStep(open.id, stepId, reason))}
      onFailStep={(stepId, note) => change(() => api.failStep(open.id, stepId, note, open.version))}
      onSuggestion={(suggestionId, action, glob) =>
        change(() => (action === 'accept' ? api.acceptSuggestion(open.id, suggestionId, glob === undefined ? {} : { glob }) : api.dismissSuggestion(open.id, suggestionId)))
      }
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
