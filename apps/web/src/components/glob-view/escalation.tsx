import { HumanIcon } from '@/components/actor-icons';
import { Tip } from '../ui/tip';
import type { GlobViewContext } from './context';

/**
 * The header's "needs a person" chip, as on the card, with the reason in its tooltip and the split evidence behind a small
 * "Why a person?" disclosure. The words "needs a" are visual only; the accessible name stays in the label.
 */
export const EscalationChip = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const { escalation } = glob;
  if (escalation == null) return null;
  return (
    <span
      id="section-escalation"
      data-section="escalation"
      className="inline-flex flex-wrap items-center gap-2 scroll-mt-12"
    >
      <Tip text={`Needs a person: ${escalation.reason}`}>
        <span
          role="note"
          aria-label="Needs a person"
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] text-required"
          data-testid="escalation-chip"
        >
          <span aria-hidden className="inline-flex items-center gap-1">
            needs a <HumanIcon className="h-3 w-3" decorative />
          </span>
        </span>
      </Tip>
      <details className="text-xs" data-testid="escalation-why">
        <summary className="cursor-pointer text-muted-foreground">Why a person?</summary>
        <div className="mt-1 grid gap-1 rounded border border-edge p-2">
          <span>{escalation.reason}</span>
          {escalation.evidence !== undefined && (
            <span className="text-muted-foreground">{escalation.evidence}</span>
          )}
          <span className="text-muted-foreground">Escalated by {escalation.by}</span>
        </div>
      </details>
    </span>
  );
};
