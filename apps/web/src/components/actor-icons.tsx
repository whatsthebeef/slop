import { Binary, Bot, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ActorIconProps {
  readonly className?: string;
  /** True where adjacent text already says it: the icon is then hidden from screen readers. */
  readonly decorative?: boolean;
  /** True while a machine step is running: the icon turns (not for people who prefer reduced motion). */
  readonly working?: boolean;
}

const SIZE = 'h-3.5 w-3.5 shrink-0';

/** Slop or its agents do the work. */
export const MachineIcon = ({ className, decorative = false, working = false }: ActorIconProps) => (
  <Bot
    className={cn(SIZE, working && 'animate-spin motion-reduce:animate-none', className)}
    strokeWidth={2}
    {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'machine', role: 'img' })}
  />
);

/** A person: the work or the judgement happens in a person's session (lucide UserRound, s15t104). */
export const HumanIcon = ({ className, decorative = false }: ActorIconProps) => (
  <UserRound
    className={cn(SIZE, className)}
    strokeWidth={2}
    {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'human', role: 'img' })}
  />
);

/** The Matrix: patterns slop mines from the board's own activity (lucide Binary). */
export const MatrixIcon = ({ className, decorative = false }: ActorIconProps) => (
  <Binary
    className={cn(SIZE, className)}
    strokeWidth={2}
    {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'the Matrix', role: 'img' })}
  />
);

/** The icon for an action's actor; nothing for bookkeeping and destructive actions. */
export const ActorIcon = ({
  actor,
  ...props
}: ActorIconProps & { readonly actor: 'machine' | 'human' | null | undefined }) =>
  actor === 'machine' ? (
    <MachineIcon {...props} />
  ) : actor === 'human' ? (
    <HumanIcon {...props} />
  ) : null;
