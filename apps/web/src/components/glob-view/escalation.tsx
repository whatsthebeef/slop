import { HumanIcon } from '@/components/actor-icons';
import { Tip } from '../ui/tip';
import type { GlobViewContext } from './context';

/**
 * The "needs a <person>" chip in the glob view header, as on the card. The reason is in its tooltip; the visible words are
 * hidden from assistive tech because the label names the chip, so the reason is never read out or shown a second time.
 */
export const EscalationChip = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  if (glob.escalation == null) return null;
  return (
    <Tip text={`Needs a person: ${glob.escalation.reason}`}>
      <span
        role="img"
        aria-label="Needs a person"
        className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 font-mono text-xs text-required"
        data-testid="escalation-chip"
      >
        <span aria-hidden className="inline-flex items-center gap-1">
          needs a <HumanIcon className="h-3 w-3" decorative />
        </span>
      </span>
    </Tip>
  );
};

/** "Why a person?": the escalation's reason and evidence, collapsed. The reason is shown here once and not in Now. */
export const EscalationSection = ({
  ctx: { glob },
  startOpen = false,
}: {
  ctx: GlobViewContext;
  startOpen?: boolean;
}) => {
  if (glob.escalation == null) return null;
  return (
    <details className="text-sm" data-testid="escalation-note" open={startOpen || undefined}>
      <summary className="cursor-pointer text-xs text-muted-foreground">Why a person?</summary>
      <div className="mt-1 grid gap-1 rounded border border-edge p-2">
        <span>{glob.escalation.reason}</span>
        {glob.escalation.evidence !== undefined && (
          <span className="text-xs text-muted-foreground">{glob.escalation.evidence}</span>
        )}
        <span className="text-xs text-muted-foreground">Escalated by {glob.escalation.by}</span>
      </div>
    </details>
  );
};
