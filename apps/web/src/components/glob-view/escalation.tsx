import { HumanIcon } from '@/components/actor-icons';
import { Tip } from '../ui/tip';
import type { GlobViewContext } from './context';

/**
 * The "needs a <person>" chip in the glob view header, as on the card: shown only while the glob is in Planning, the one rule
 * for both. After that the reason lives in the "Changed from sub to same because …" line. The reason is in its tooltip; the visible words are
 * hidden from assistive tech because the label names the chip, so the reason is never read out or shown a second time.
 */
export const EscalationChip = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  if (glob.escalation == null || glob.status !== 'planning') return null;
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

/** The reason as the tail of a sentence: its first word loses its capital unless it looks like a name or an acronym. */
const inSentence = (reason: string): string => {
  const text = reason.trim().replace(/\.$/, '');
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
};

/** The escalation as one plain line ("Changed from sub to same because …", who and when), with the evidence collapsed under "Details". */
export const EscalationSection = ({
  ctx: { glob },
  startOpen = false,
}: {
  ctx: GlobViewContext;
  startOpen?: boolean;
}) => {
  const escalation = glob.escalation;
  if (escalation == null) return null;
  return (
    <div className="grid gap-1 text-sm" data-testid="escalation-note">
      <span>Changed from sub to same because {inSentence(escalation.reason)}.</span>
      <span className="text-xs text-muted-foreground">
        By {escalation.by}, {escalation.at.slice(0, 10)}
      </span>
      {escalation.evidence !== undefined && escalation.evidence !== '' && (
        <details open={startOpen || undefined}>
          <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
          <p className="mt-1 whitespace-pre-line rounded border border-edge p-2 text-xs text-muted-foreground">{escalation.evidence}</p>
        </details>
      )}
    </div>
  );
};
