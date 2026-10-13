import { decisionOf } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { GroupChip } from '../glob-card';
import { GlobTitle } from '../glob-title';
import { LabelChips } from '../labels';
import { Tip } from '../ui/tip';
import type { GlobView } from '@/lib/api';
import type { GlobViewContext } from './context';
import { TypeChip } from './actions';
import { EscalationChip } from './escalation';
import type { GlobActionsState } from './actions';

const STATUS_TEXT: Record<GlobView['status'], string> = {
  planning: 'Planning',
  implementing: 'A routine is implementing',
  in_progress: 'In progress',
  failed: 'Failed',
  pr_open: 'PR open for review',
  merging: 'Merging',
  reviewing: 'Merged; awaiting sign-off',
  signed_off: 'Signed off',
};

/** A decision glob uses the same lists for a different journey: it is decided in Doing and signed off once accepted. */
const DECISION_STATUS_TEXT: Partial<Record<GlobView['status'], string>> = {
  in_progress: 'Doing: being decided',
  reviewing: 'Decided; awaiting sign-off',
};

/** The CSS variable on the page holding the sticky header's height; sections scroll to just below it. */
export const HEADER_HEIGHT_VAR = '--glob-header-height';

/** The sticky header: back to the board and the title (editable until signed off). */
export const GlobHeader = ({
  ctx,
  onClose,
  onReload,
}: {
  ctx: GlobViewContext;
  onClose: () => void;
  onReload: () => Promise<void>;
}) => {
  const { glob, onUpdate } = ctx;
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
  // The bar grows with a wrapping title: its measured height is published for the sections' scroll margin.
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
        className={`sticky top-0 z-10 -mx-5 -mt-5 mb-4 flex min-h-10 items-start py-1.5 gap-3 border-b bg-background px-5 ${scrolled ? 'border-border' : 'border-transparent'}`}
        data-testid="glob-header"
      >
        <Tip text="Back to the board (Esc)">
          <Link
            to={`/boards/${String(glob.boardId)}`}
            className="rounded p-1 hover:bg-muted"
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
        <GlobTitle
          id={glob.id}
          title={glob.title}
          editable={glob.status !== 'signed_off'}
          onUpdate={onUpdate}
          onReload={onReload}
        />
      </div>
    </>
  );
};

/** The chips under the title: status, type, activity, group, labels, branch and version. */
export const GlobChips = ({
  ctx,
  actions,
}: {
  ctx: GlobViewContext;
  actions: GlobActionsState;
}) => {
  const { board, glob } = ctx;
  const decision = decisionOf(glob) !== null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded bg-muted px-2 py-0.5">
        {(decision ? DECISION_STATUS_TEXT[glob.status] : undefined) ?? STATUS_TEXT[glob.status]}
      </span>
      {decision ? (
        <span className="rounded border px-2 py-0.5 text-xs" data-testid="glob-type">
          decision
        </span>
      ) : (
        <TypeChip ctx={ctx} state={actions} />
      )}
      <EscalationChip ctx={ctx} />
      {glob.group !== null && <GroupChip name={glob.group} />}
      {!decision && <LabelChips glob={glob} />}
      <span className="ml-auto text-xs text-muted-foreground">
        {!decision && (
          <>
            branch{' '}
            {board.repo === null ? (
              <span className="font-mono">{glob.branch}</span>
            ) : (
              <a
                className="font-mono underline-offset-2 hover:underline"
                href={`https://github.com/${board.repo}/compare/${board.baseBranch}...${glob.branch}`}
                target="_blank"
                rel="noreferrer"
                title={`Compare ${glob.branch} with ${board.baseBranch} on GitHub`}
              >
                {glob.branch}
              </a>
            )}{' '}
            ·{' '}
          </>
        )}
        v{glob.version}
      </span>
    </div>
  );
};
