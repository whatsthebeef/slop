import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { isHumanCategory, modeOf } from '@slop/core';
import { GroupChip } from '../glob-card';
import { Tip } from '../ui/tip';
import { LIST_TITLES } from '@/lib/list-titles';
import { boardGroupPath } from '@/lib/group-page';
import type { GlobViewContext } from './context';
import { EscalationChip } from './escalation';
import { TypeChip } from './actions';
import type { GlobActionsState } from './actions';
import { TAG } from './tag-style';
import { Dot, HeaderStatus } from './status';
import type { NowState } from './status';

/** The CSS variable on the page holding the sticky header's height; sections scroll to just below it. */
export const HEADER_HEIGHT_VAR = '--glob-header-height';

/** The sticky bar (list hidden below the sm breakpoint), a compact single row (small vertical padding, no fixed height): back to the board, then "ID · list", and the status at the top right. Identity and status only. */
export const GlobHeader = ({
  ctx,
  onClose,
  state,
}: {
  ctx: GlobViewContext;
  onClose: () => void;
  state: NowState;
}) => {
  const { glob } = ctx;
  // The header's border shows once the page has scrolled under it.
  const topRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = topRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) =>
      setScrolled(entry !== undefined && !entry.isIntersecting),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The bar's measured height is published for the sections' scroll margin (the font size can change it).
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const page = bar?.parentElement;
    if (bar === null || page === null || page === undefined || typeof ResizeObserver === 'undefined') return undefined;
    const publish = () => page.style.setProperty(HEADER_HEIGHT_VAR, `${String(bar.offsetHeight)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      page.style.removeProperty(HEADER_HEIGHT_VAR);
    };
  }, []);
  return (
    <>
      <div ref={topRef} aria-hidden className="h-0" />
      <div
        ref={barRef}
        className={`sticky top-0 z-10 -mx-5 -mt-5 flex items-center gap-3 py-1 leading-5 border-b bg-background px-5 ${scrolled ? 'border-border' : 'border-transparent'}`}
        data-testid="glob-header"
      >
        <Tip text="Back to the board (Esc)">
          <Link
            to={`/boards/${String(glob.boardId)}`}
            className="rounded p-1.5 hover:bg-muted"
            aria-label="Back to the board"
            data-testid="glob-back"
            onClick={(e) => {
              e.preventDefault();
              onClose();
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Tip>
        <span className="shrink-0 self-center font-mono text-base font-semibold text-muted-foreground" data-testid="glob-id">
          {glob.id}
        </span>
        <span className="hidden items-center gap-3 sm:flex">
          <Dot />
        </span>
        <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline" data-testid="glob-list">
          {LIST_TITLES[glob.list]}
        </span>
        <HeaderStatus glob={glob} state={state} />
      </div>
    </>
  );
};

/**
 * The row under the title: the group tag, the type control styled like it (plain text for human work, which has no type to change)
 * and, only while it applies, the needs-a-person chip. No empty line is left when there is none of them.
 */
export const GlobChips = ({ ctx, actions }: { ctx: GlobViewContext; actions?: GlobActionsState }) => {
  const { glob } = ctx;
  const human = isHumanCategory(glob.category);
  const type =
    human || actions === undefined || glob.type === null ? (
      <span className={`${TAG} bg-muted text-muted-foreground`} data-testid="glob-type">
        {modeOf(glob)}
      </span>
    ) : (
      <TypeChip ctx={ctx} state={actions} />
    );
  const escalated = glob.escalation != null && glob.status === 'planning';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="glob-chips">
      {glob.group !== null && (
        <span className="min-w-0 max-w-full" data-testid="glob-group">
          <GroupChip name={glob.group} to={boardGroupPath(glob.boardId, glob.group)} />
        </span>
      )}
      {type}
      {escalated && <EscalationChip ctx={ctx} />}
    </div>
  );
};
