import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { handoverOneLine } from '@/lib/handover';
import { stripMarkdown } from '@/lib/markdown-text';
import { InlineMarkdown } from '../markdown-view';
import { handoverKey, shortLabel } from '@/lib/dismissals';
import { cn } from '@/lib/utils';
import type { GlobActionsState } from './actions';
import { Block, blockActor } from './block';
import type { GlobViewContext } from './context';
import { GotIt, Link, LinkButton, capitalised, shownElsewhere } from './status';
import type { NowState } from './status';

const CLAMP_AT = 200;

/** A long line (a run's whole failure reason) cut to its first lines, with a toggle for the rest. */
const Clamped = ({ text }: { text: string }) => {
  const [more, setMore] = useState(false);
  if (text.length <= CLAMP_AT) return <InlineMarkdown text={text} />;
  return (
    <>
      {more ? <InlineMarkdown text={text} /> : `${stripMarkdown(text).slice(0, CLAMP_AT).trimEnd()}…`}{' '}
      <button
        type="button"
        className="cursor-pointer text-xs underline"
        data-testid="clamp-toggle"
        onClick={() => setMore(!more)}
      >
        {more ? 'show less' : 'show more'}
      </button>
    </>
  );
};

/**
 * The problem section, one block above the actions: what is wrong (the status line: failed checks, a failed run, a stuck
 * merge) and, for whoever holds the ball, why they are needed and what to do first (the handover brief). A merge conflict is
 * the conflict block's, so its line and its brief cause are left out here.
 */
export const ProblemSection = ({
  ctx: { glob },
  state,
  actions,
}: {
  ctx: GlobViewContext;
  state: NowState;
  actions: GlobActionsState;
}) => {
  const { problem, seen, brief } = state;
  const conflict = glob.failure?.conflict ?? glob.conflict ?? null;
  const line =
    problem !== null && seen !== null && problem.conflict !== true ? { problem, seen } : null;
  const omit = shownElsewhere(glob, problem);
  const causes = (brief?.why ?? []).filter(
    (c) =>
      !omit.includes(c) && (conflict === null || !c.startsWith(`Conflicts with ${conflict.base}`)),
  );
  const detail = (brief?.detail ?? []).filter((l) => !omit.includes(l));
  // A brief that is only the conflict is the conflict block's advice.
  const shownBrief =
    brief !== null &&
    (conflict === null || brief.why.some((c) => !c.startsWith(`Conflicts with ${conflict.base}`)))
      ? brief
      : null;
  if (line === null && shownBrief === null) return null;
  const read = actions.briefRead && !actions.briefOpen;
  const lead = line !== null;
  const hasList = causes.length > 0 || detail.length > 0;
  return (
    <Block
      tone="problem"
      actor={blockActor(glob)}
      testId="problem-block"
      title={line === null ? "Why you're needed" : capitalised(shortLabel(line.problem))}
      why={
        line === null ? undefined : line.seen.dismissed ? (
          <p
            className="text-muted-foreground"
            data-testid="status-line"
            data-kind={line.problem.kind}
            data-dismissed="true"
          >
            <LinkButton
              testId="show-again"
              disabled={actions.busy}
              onClick={() => void actions.dismiss(line.seen.key, false)}
            >
              Show again
            </LinkButton>
          </p>
        ) : (
          <p
            className={cn(line.problem.tone)}
            data-testid="status-line"
            data-kind={line.problem.kind}
          >
            {line.problem.full}
            {line.problem.doing !== null && (
              <span className="font-normal">
                {' — '}
                {line.problem.sessionUrl === null ? (
                  line.problem.doing
                ) : (
                  <Link href={line.problem.sessionUrl}>{line.problem.doing}</Link>
                )}
              </span>
            )}
            {line.problem.url !== null && (
              <>
                {' ('}
                <Link href={line.problem.url}>check run</Link>
                {glob.pr?.headSha != null &&
                  !line.problem.full.includes(glob.pr.headSha.slice(0, 7)) &&
                  `, ${glob.pr.headSha.slice(0, 7)}`}
                )
              </>
            )}
            {line.problem.kind !== 'rollout' && (
              <GotIt
                disabled={actions.busy}
                onClick={() => void actions.dismiss(line.seen.key, true)}
              />
            )}
          </p>
        )
      }
      {...(shownBrief !== null && !read ? { fix: { text: `How to fix: ${shownBrief.next}` } } : {})}
      {...(shownBrief !== null && !read
        ? {
            actions: (
              <Button
                size="sm"
                variant="ghost"
                data-testid="handover-acknowledge"
                onClick={() => {
                  void actions.dismiss(handoverKey(shownBrief), true);
                  actions.setBriefOpen(false);
                }}
              >
                Got it
              </Button>
            ),
          }
        : {})}
    >
      {shownBrief !== null && (read || hasList || lead) && (
        <div className="grid gap-1" data-testid="handover-box">
          {read ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                {lead && <strong>Why you're needed: </strong>}
                {handoverOneLine(shownBrief)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                data-testid="handover-expand"
                onClick={() => actions.setBriefOpen(true)}
              >
                Show
              </Button>
            </div>
          ) : (
            <>
              {lead && <strong>Why you're needed</strong>}
              {causes.length > 0 && (
                <ul className="list-disc pl-5">
                  {causes.map((cause) => (
                    <li key={cause}>
                      <Clamped text={cause} />
                    </li>
                  ))}
                </ul>
              )}
              {detail.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {detail.map((l) => (
                    <li key={l}>
                      <InlineMarkdown text={l} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Block>
  );
};
