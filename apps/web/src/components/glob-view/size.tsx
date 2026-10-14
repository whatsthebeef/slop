import { OversizedGlob, isOversized } from '@/components/oversized-glob';
import type { OversizedState } from '@/components/oversized-glob';
import { SplitGlob, canSplit } from '@/components/split-glob';
import type { GlobView } from '@/lib/api';
import type { GlobViewContext } from './context';

/** Whether the actions menu offers Split… on a glob that isn't flagged oversized (an oversized one has its own moves). */
export const splittable = (glob: GlobView, decision: boolean): boolean =>
  !decision && canSplit(glob) && (glob.allowedActions ?? []).includes('delete') && !isOversized(glob);

/** The size section: a flagged glob's explanation, and the split form that Split… and Edit split in the actions open. */
export const SizeSection = ({
  ctx: { glob },
  decision,
  size,
  splitting,
  onSplitting,
  onClose,
}: {
  ctx: GlobViewContext;
  /** A decision glob has no PR to size or split; its split form can still be open. */
  decision: boolean;
  size: OversizedState;
  /** The split form is open (the page's Esc handling needs to know). */
  splitting: boolean;
  onSplitting: (splitting: boolean) => void;
  onClose: () => void;
}) => {
  const oversized = !decision && isOversized(glob);
  if (splitting)
    return (
      <SplitGlob
        glob={glob}
        onCancel={() => onSplitting(false)}
        onDone={onClose}
      />
    );
  return oversized ? <OversizedGlob glob={glob} size={size} /> : null;
};
