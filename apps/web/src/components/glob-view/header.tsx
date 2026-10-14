import { decisionOf } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { GroupChip } from '../glob-card';
import { LabelChips } from '../labels';
import { Tip } from '../ui/tip';
import { groupPath } from '@/lib/group-page';
import type { GlobViewContext } from './context';
import { TypeChip } from './actions';
import { EscalationChip } from './escalation';
import type { GlobActionsState } from './actions';
import { HeaderStatus } from './status';
import type { NowState } from './status';

/** The CSS variable on the page holding the sticky header's height; sections scroll to just below it. */
export const HEADER_HEIGHT_VAR = '--glob-header-height';

/** The sticky bar, a compact single row (small vertical padding, no fixed height): back to the board, the glob's ID, and the status at the top right. */
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
  const decision = decisionOf(glob) !== null;
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
        <HeaderStatus glob={glob} decision={decision} state={state} />
      </div>
    </>
  );
};

/** The chips under the title: type, escalation, group and labels. */
export const GlobChips = ({
  ctx,
  actions,
}: {
  ctx: GlobViewContext;
  actions: GlobActionsState;
}) => {
  const { glob } = ctx;
  const decision = decisionOf(glob) !== null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {decision ? (
        <span className="rounded border px-2 py-0.5 text-xs" data-testid="glob-type">
          decision
        </span>
      ) : (
        <TypeChip ctx={ctx} state={actions} />
      )}
      <EscalationChip ctx={ctx} />
      {glob.group !== null && <GroupChip name={glob.group} to={groupPath(glob.boardId, glob.group)} />}
      {!decision && <LabelChips glob={glob} />}
    </div>
  );
};
