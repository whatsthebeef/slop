import { isHumanCategory, modeOf } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { ArmSystemLabel } from '../glob-card';
import { Tip } from '../ui/tip';
import { armLabel } from '@/lib/rollout-stages';
import { findSection } from '@/lib/glob-scroll';
import { LIST_TITLES } from '@/lib/list-titles';
import type { GlobViewContext } from './context';
import { TypeChip } from './actions';
import { EscalationChip } from './escalation';
import type { GlobActionsState } from './actions';
import { Dot, HeaderStatus } from './status';
import type { NowState } from './status';

/** The CSS variable on the page holding the sticky header's height; sections scroll to just below it. */
export const HEADER_HEIGHT_VAR = '--glob-header-height';

/** The sticky bar (type and list hidden below the sm breakpoint), a compact single row (small vertical padding, no fixed height): back to the board, then "ID · type ▾ · list", and the status at the top right. */
export const GlobHeader = ({
  ctx,
  onClose,
  state,
  actions,
}: {
  ctx: GlobViewContext;
  onClose: () => void;
  state: NowState;
  /** The actions state the type control works from; without it (or for a decision) the type shows as plain text. */
  actions?: GlobActionsState;
}) => {
  const { glob } = ctx;
  // Human work (a decision, an action) has no type to change, no deploy to arm and no machine status.
  const human = isHumanCategory(glob.category);
  const arming = human ? null : armLabel(glob);
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
        {human || actions === undefined || glob.type === null ? (
          <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline" data-testid="glob-type">
            {modeOf(glob)}
          </span>
        ) : (
          <span className="hidden shrink-0 sm:inline">
            <TypeChip ctx={ctx} state={actions} />
          </span>
        )}
        <span className="hidden items-center gap-3 sm:flex">
          <Dot />
        </span>
        <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline" data-testid="glob-list">
          {LIST_TITLES[glob.list]}
        </span>
        {arming !== null && (
          <ArmSystemLabel label={arming} onOpen={() => findSection(document, 'human-steps')?.scrollIntoView({ block: 'start' })} />
        )}
        <HeaderStatus glob={glob} decision={human} state={state} />
      </div>
    </>
  );
};

/** The needs-a-person chip under the title, only while it applies, so no empty line is left there; type, group and labels live elsewhere. */
export const GlobChips = ({ ctx }: { ctx: GlobViewContext }) =>
  ctx.glob.escalation == null || ctx.glob.status !== 'planning' ? null : (
    <div className="flex items-center gap-2 text-sm">
      <EscalationChip ctx={ctx} />
    </div>
  );
