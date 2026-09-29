import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { applyTheme, loadTheme, type ThemeChoice } from '../lib/theme.ts';
import { Button } from './ui/button.tsx';

const next: Record<ThemeChoice, ThemeChoice> = { system: 'dark', dark: 'light', light: 'system' };
const label: Record<ThemeChoice, string> = {
  system: 'Theme: follows your system',
  dark: 'Theme: dark',
  light: 'Theme: light',
};

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  const Icon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`${label[choice]}. Switch theme`}
      title={label[choice]}
      onClick={() => {
        const n = next[choice];
        applyTheme(n);
        setChoice(n);
      }}
    >
      <Icon className="size-5" aria-hidden />
    </Button>
  );
}
