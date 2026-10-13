import { Bot, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ActorIconProps {
  readonly className?: string;
  /** True where adjacent text already says it: the icon is then hidden from screen readers. */
  readonly decorative?: boolean;
}

const SIZE = 'h-3.5 w-3.5 shrink-0';

/** Slop or its agents do the work. */
export const MachineIcon = ({ className, decorative = false }: ActorIconProps) => (
  <Bot className={cn(SIZE, className)} strokeWidth={2} {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'machine' })} />
);

/** The work or the judgement happens in a person's session. */
export const HumanIcon = ({ className, decorative = false }: ActorIconProps) => (
  <Brain className={cn(SIZE, className)} strokeWidth={2} {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'human' })} />
);

/** The icon for an action's actor; nothing for bookkeeping and destructive actions. */
export const ActorIcon = ({ actor, ...props }: ActorIconProps & { readonly actor: 'machine' | 'human' | null | undefined }) =>
  actor === 'machine' ? <MachineIcon {...props} /> : actor === 'human' ? <HumanIcon {...props} /> : null;
