import { AlertTriangle, Check, Hourglass } from 'lucide-react';
import { ActorIcon, MachineIcon } from '@/components/actor-icons';
import type { StatusIcon } from '@/lib/card-rows';

/** The icon of the status in the card's and the glob view header's top right; it sits right of the status text. */
export const StatusIconView = ({ icon }: { icon: StatusIcon }) => {
  if (icon === 'machine-spinning') return <MachineIcon working className='h-3 w-3 shrink-0' decorative />;
  if (icon === 'machine') return <ActorIcon actor='machine' className='h-3 w-3 shrink-0' decorative />;
  if (icon === 'human' || icon === 'needs-human') return <ActorIcon actor='human' className='h-3 w-3 shrink-0' decorative />;
  if (icon === 'hourglass') return <Hourglass className='h-3 w-3 shrink-0' aria-hidden />;
  if (icon === 'check') return <Check className='h-3 w-3 shrink-0' aria-hidden />;
  return <AlertTriangle className='h-3 w-3 shrink-0' aria-hidden />;
};
