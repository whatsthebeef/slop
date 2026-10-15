import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import type { GlobView } from '@/lib/api';
import { copyOrSelect } from '@/lib/plan-text';
import { cn } from '@/lib/utils';

/** What a block is about: a problem to fix, something that needs a person, or information. One token set for all three. */
export type BlockTone = 'problem' | 'person' | 'info';

/** Who acts on it, as on the card corner. */
export type BlockActor = 'human' | 'machine';

/** The look of each tone: the border and tint on top of the shared card (same radius, padding and spacing as Decide). */
export const BLOCK_TONES: Readonly<Record<BlockTone, string>> = {
  problem: 'border-destructive/60 bg-destructive/5',
  person: 'border-2 border-foreground',
  info: 'border-edge bg-muted/40',
};

/** The machine when a run is working on the glob or holds the move, else a person. */
export const blockActor = (glob: Pick<GlobView, 'currentRun' | 'move'>): BlockActor =>
  glob.currentRun?.state === 'active' || glob.move?.holder === 'machine' ? 'machine' : 'human';

/** "How to fix": one plain line, with a command and a Copy button when there is one to run. */
export interface BlockFix {
  readonly text: string;
  readonly command?: string;
  /** The command's test id, for a block whose command an existing test already finds by it. */
  readonly commandTestId?: string;
}

const FixLine = ({ fix }: { fix: BlockFix }) => {
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const { command } = fix;
  const copy = () => {
    if (command === undefined) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    void copyOrSelect(command, clipboard, () => {
      const node = code.current;
      if (node === null) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }).then(setCopied);
  };
  return (
    <div className="grid gap-1 text-sm" data-testid="block-fix">
      <span>{fix.text}</span>
      {command !== undefined && (
        <span className="flex items-center gap-2">
          <code
            ref={code}
            className="block select-all whitespace-pre-wrap font-mono text-xs"
            data-testid={fix.commandTestId ?? 'block-fix-command'}
          >
            {command}
          </code>
          <button
            type="button"
            className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
            data-testid="block-fix-copy"
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      )}
    </div>
  );
};

/**
 * The one block every notice above the action button is made of: a bordered card with a head line (the actor's icon and a short
 * title), one plain sentence saying why, a body (folded under a label when it is long), then either `actions` (only where the
 * block is the place to act) or a single "how to fix" line. Plain text only: nothing in a block is rendered as Markdown.
 */
export const Block = ({
  tone,
  actor,
  title,
  why,
  fold,
  fix,
  more,
  actions,
  children,
  id,
  testId,
}: {
  tone: BlockTone;
  actor: BlockActor;
  title: ReactNode;
  /** One sentence under the head line. */
  why?: ReactNode;
  /** Folds the body under this label (open when `open`); without it the body is always shown. */
  fold?: { readonly label: string; readonly open?: boolean };
  fix?: BlockFix;
  /** Something collapsed that belongs after the fix line (the by-hand route). */
  more?: ReactNode;
  /** Buttons for a block that is the place to act (Done, Dismiss, an approval); leave out when the action row has the main action. */
  actions?: ReactNode;
  /** The body: the details in plain text. */
  children?: ReactNode;
  id?: string;
  testId?: string;
}) => {
  const head = useId();
  const body =
    children === undefined || children === null || children === false ? null : fold ===
      undefined ? (
      <div className="grid min-w-0 gap-1 break-words" data-testid="block-body">
        {children}
      </div>
    ) : (
      <details open={fold.open === true ? true : undefined} data-testid="block-body">
        <summary className="cursor-pointer text-xs text-muted-foreground">{fold.label}</summary>
        <div className="mt-1 grid min-w-0 gap-1 break-words">{children}</div>
      </details>
    );
  return (
    <section
      id={id}
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded border p-3 text-sm',
        BLOCK_TONES[tone],
      )}
      aria-labelledby={head}
      data-testid={testId ?? 'block'}
      data-block={tone}
    >
      <h3
        id={head}
        className="flex min-w-0 items-center gap-2 text-sm font-semibold"
        data-testid="block-head"
      >
        {actor === 'machine' ? <MachineIcon decorative /> : <HumanIcon decorative />}
        <span className="min-w-0 break-words">{title}</span>
      </h3>
      {why !== undefined && why !== null && why !== false && (
        <div className="min-w-0 break-words" data-testid="block-why">
          {why}
        </div>
      )}
      {body}
      {fix !== undefined && <FixLine fix={fix} />}
      {more !== undefined && more !== null && more !== false && (
        <div data-testid="block-more">{more}</div>
      )}
      {actions !== undefined && actions !== null && actions !== false && (
        <div className="flex flex-wrap items-center gap-2" data-testid="block-actions">
          {actions}
        </div>
      )}
    </section>
  );
};
