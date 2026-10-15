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

/**
 * A running person: the kind icon of an action, so it isn't read as the human actor's person. lucide has no running figure, so
 * this draws the path data of the `run` icon from Tabler Icons (MIT, https://tabler.io/icons) in lucide's style: 24x24, 2px
 * round stroke, current colour. It takes the props lucide icons take, so a Tip can wrap it.
 */
export const PersonRunning = ({
  className,
  ...props
}: {
  className?: string;
  'aria-label'?: string;
  'aria-hidden'?: boolean;
  role?: 'img';
}) => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth={2}
    strokeLinecap='round'
    strokeLinejoin='round'
    className={className}
    data-icon='person-running'
    {...props}
  >
    <path d='M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0' />
    <path d='M4 17l5 1l.75 -1.5' />
    <path d='M15 21l0 -4l-4 -3l1 -6' />
    <path d='M7 12l0 -3l5 -1l3 3l3 1' />
  </svg>
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
