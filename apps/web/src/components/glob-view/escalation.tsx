import { HumanIcon } from '@/components/actor-icons';
import type { GlobViewContext } from './context';

/** Why the glob needs a person, when it was escalated. */
export const EscalationSection = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  if (glob.escalation == null) return null;
  return (
    <div
      className="grid gap-1 rounded border border-edge p-2 text-sm"
      data-testid="escalation-note"
    >
      <span>
        <span className="sr-only">Needs a person: {glob.escalation.reason}</span>
        <span
          aria-hidden
          title={`Needs a person: ${glob.escalation.reason}`}
          className="inline-flex items-center gap-1"
        >
          needs a <HumanIcon decorative />: {glob.escalation.reason}
        </span>
      </span>
      {glob.escalation.evidence !== undefined && (
        <span className="text-xs text-muted-foreground">{glob.escalation.evidence}</span>
      )}
      <span className="text-xs text-muted-foreground">Escalated by {glob.escalation.by}</span>
    </div>
  );
};
