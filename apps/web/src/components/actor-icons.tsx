import { Bot, UserRound } from 'lucide-react';

interface ActorIconProps {
  className?: string;
  /** Hide from screen readers when the surrounding text already names the actor. */
  decorative?: boolean;
}

/** A person: the glob is waiting on a human. */
export function HumanIcon({ className, decorative = false }: ActorIconProps) {
  return (
    <UserRound
      className={className}
      {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'human', role: 'img' })}
    />
  );
}

/** The machine: an agent is working. */
export function MachineIcon({ className, decorative = false }: ActorIconProps) {
  return (
    <Bot
      className={className}
      {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'machine', role: 'img' })}
    />
  );
}
