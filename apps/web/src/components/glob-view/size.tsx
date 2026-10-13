import { Button } from '@/components/ui/button';
import { OversizedGlob, isOversized } from '@/components/oversized-glob';
import { SplitGlob, canSplit } from '@/components/split-glob';
import { Tip } from '@/components/ui/tip';
import type { GlobViewContext } from './context';

/** The size section: a flagged glob's keep-or-split choice, and the Split button with its form. */
export const SizeSection = ({
  ctx: { board, glob, busy },
  decision,
  splitting,
  onSplitting,
  onClose,
}: {
  ctx: GlobViewContext;
  /** A decision glob has no PR to size or split; its split form can still be open. */
  decision: boolean;
  /** The split form is open (the page's Esc handling needs to know). */
  splitting: boolean;
  onSplitting: (splitting: boolean) => void;
  onClose: () => void;
}) => {
  const oversized = !decision && isOversized(glob);
  const splittable =
    !decision && canSplit(glob) && (glob.allowedActions ?? []).includes('delete') && !oversized;
  return (
    <>
      {splittable && !splitting && (
        <div>
          <Tip text="Cut this glob into parts: part 1 stays here, the others are created with their share of the plan">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid="split-glob"
              onClick={() => onSplitting(true)}
            >
              Split
            </Button>
          </Tip>
        </div>
      )}
      {oversized && (
        <OversizedGlob
          glob={glob}
          canKeep={board.role !== 'qa' || glob.type === 'sub'}
          onDone={onClose}
        />
      )}
      {splitting && <SplitGlob glob={glob} onCancel={() => onSplitting(false)} onDone={onClose} />}
    </>
  );
};
