import type { ContextDiffLine } from '@slop/core';
import { useState } from 'react';

/** Diffs longer than this start collapsed. */
export const LONG_DIFF = 40;

/** The lines to show: all of them, or the first `collapseAfter` while a long diff is collapsed. */
export const visibleLines = <T,>(lines: readonly T[], expanded: boolean, collapseAfter = LONG_DIFF): readonly T[] =>
  lines.length > collapseAfter && !expanded ? lines.slice(0, collapseAfter) : lines;

const TONE = {
  removed: 'bg-red-500/10 text-red-700 dark:text-red-300',
  added: 'bg-green-500/10 text-green-700 dark:text-green-300',
  same: 'text-muted-foreground',
} as const;

const MARK = { removed: '- ', added: '+ ', same: '  ' } as const;

/** One line of a diff: red for removed, green for added, muted for context. */
export const DiffRow = ({ op, text }: { op: 'removed' | 'added' | 'same'; text: string }) => (
  <div className={TONE[op]}>
    {MARK[op]}
    {text}
  </div>
);

/** The rows of a diff with context: a run of unchanged lines the server left out shows as one muted line. */
export const DiffLines = ({ lines }: { lines: readonly ContextDiffLine[] }) =>
  lines.map((line, index) =>
    line.op === 'skipped' ? (
      <div key={index} className='text-muted-foreground'>
        … {line.count} unchanged line{line.count === 1 ? '' : 's'}
      </div>
    ) : (
      <DiffRow key={index} op={line.op} text={line.text} />
    ),
  );

/**
 * A line diff that collapses past `collapseAfter` lines, with a toggle. Used by the Knowledge page's drafts and by the
 * decision glob's diff of the proposed change.
 */
export const DiffView = ({ lines, collapseAfter = LONG_DIFF, testId = 'draft-diff' }: { lines: readonly ContextDiffLine[]; collapseAfter?: number; testId?: string }) => {
  const [expanded, setExpanded] = useState(false);
  const long = lines.length > collapseAfter;
  return (
    <>
      <pre className='max-h-[32rem] overflow-auto rounded-md border text-xs' data-testid={testId}>
        <DiffLines lines={visibleLines(lines, expanded, collapseAfter)} />
      </pre>
      {long && (
        <button type='button' className='w-fit text-muted-foreground hover:underline' onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
};
