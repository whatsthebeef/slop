import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { FILTER_TOGGLE_ID, FilterPane, FilterToggle, useBoardFilters } from '@/components/board-filter-pane';
import type { BoardShellContext } from '@/components/board-shell';
import { GlobCard } from '@/components/glob-card';
import { AutomationGroup } from '@/components/settings/automation-group';
import { BoardGroup } from '@/components/settings/board-group';
import { EnvironmentsGroup } from '@/components/settings/environments-group';
import { useSettingsForm } from '@/components/settings/form';
import { MembersGroup } from '@/components/settings/members-group';
import { ReportsGroup, SystemGroup } from '@/components/settings/reports-system-groups';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { matchesFilters } from '@/lib/board-filters';
import { globPath } from '@/lib/glob-section';
import { learnedPanelOf, learnedPath } from '@/lib/learned';
import { usePageContext } from '@/lib/page-context';

/**
 * What a person chooses for the board, in six collapsible groups (the last, System, collapsed by default). What slop has
 * learned (size, subs, risk areas, escalations, dependency rules, intake, context tuning, learning jobs) is on the Knowledge page;
 * an old link into one of those (`?section=<name>`) is sent there.
 */
export const SettingsPage = () => {
  const boardId = Number(useParams().boardId);
  usePageContext({ type: 'settings' });
  const form = useSettingsForm(boardId);
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const moved = learnedPanelOf(params.get('section')) ?? learnedPanelOf(hash.slice(1));
  if (moved !== null) return <Navigate replace to={learnedPath(boardId, moved)} />;
  if (form.board.data === undefined) return <p className='p-6 text-muted-foreground'>Loading…</p>;
  const board = form.board.data;
  const admin = board.role === 'admin';

  return (
    <main className='mx-auto grid max-w-2xl gap-4 p-6'>
      <BoardGroup board={board} admin={admin} form={form} readinessLinked={hash === '#readiness'} />
      <MembersGroup boardId={boardId} admin={admin} />
      <EnvironmentsGroup admin={admin} form={form} />
      <AutomationGroup admin={admin} form={form} />
      <ReportsGroup boardId={boardId} />
      <SystemGroup boardId={boardId} admin={admin} />
    </main>
  );
};

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
