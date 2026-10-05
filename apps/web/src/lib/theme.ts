import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'slop-theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

const saved = (): Theme | null => {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
};

const apply = (theme: Theme) => document.documentElement.classList.toggle('dark', theme === 'dark');

/**
 * The board's theme: the saved choice, else the system's (followed live until a choice is made).
 * index.html applies it before the first paint; this keeps React and the page in step.
 */
export const useTheme = (): { theme: Theme; toggle: () => void } => {
  const [theme, setTheme] = useState<Theme>(() => saved() ?? (systemDark() ? 'dark' : 'light'));

  useEffect(() => {
    apply(theme);
  }, [theme]);

  useEffect(() => {
    if (saved() !== null) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => {
      if (saved() === null) setTheme(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private windows can refuse storage; the switch still applies for this visit.
    }
    setTheme(next);
  };

  return { theme, toggle };
};
