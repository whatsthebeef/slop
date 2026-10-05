import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme';

/** Switches light and dark; the choice is remembered in this browser. */
export const ThemeToggle = () => {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type='button'
      onClick={toggle}
      className='press fixed right-4 bottom-4 z-30 inline-flex h-8 w-8 items-center justify-center rounded-md border border-foreground/70 bg-card text-foreground hover:bg-muted'
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      data-testid='theme-toggle'
    >
      {theme === 'dark' ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
    </button>
  );
};
