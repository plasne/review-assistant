import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES } from '../../src/main/themes/built-in';
import { applyTheme, applyThemeState, contrastRatio, readableTextColor } from '../../src/renderer/theme';
import type { ThemeTokens } from '../../src/shared/types';

const tokens: ThemeTokens = {
  bg: '#010203',
  bg2: '#111213',
  surface: '#212223',
  surface2: '#313233',
  border: '#414243',
  text: '#515253',
  textDim: '#616263',
  accent: '#717273',
  accent2: '#818283',
  success: '#919293',
  warning: '#a1a2a3',
  danger: '#b1b2b3',
  focusRing: '#c1c2c3',
  fontSans: '"Theme Sans", sans-serif',
  fontSerif: '"Theme Serif", serif'
};

describe('renderer theme application', () => {
  it('maps every theme token to its CSS custom property', () => {
    applyTheme(tokens);

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--bg')).toBe('#010203');
    expect(style.getPropertyValue('--bg-2')).toBe('#111213');
    expect(style.getPropertyValue('--surface')).toBe('#212223');
    expect(style.getPropertyValue('--surface-2')).toBe('#313233');
    expect(style.getPropertyValue('--border')).toBe('#414243');
    expect(style.getPropertyValue('--text')).toBe('#515253');
    expect(style.getPropertyValue('--text-dim')).toBe('#616263');
    expect(style.getPropertyValue('--accent')).toBe('#717273');
    expect(style.getPropertyValue('--accent-2')).toBe('#818283');
    expect(style.getPropertyValue('--success')).toBe('#919293');
    expect(style.getPropertyValue('--warning')).toBe('#a1a2a3');
    expect(style.getPropertyValue('--danger')).toBe('#b1b2b3');
    expect(style.getPropertyValue('--focus-ring')).toBe('#c1c2c3');
    expect(style.getPropertyValue('--font-sans')).toBe('"Theme Sans", sans-serif');
    expect(style.getPropertyValue('--font-serif')).toBe('"Theme Serif", serif');
    expect(style.getPropertyValue('--accent-text')).toBe(readableTextColor(tokens.accent, tokens));
    expect(style.getPropertyValue('--success-text')).toBe(readableTextColor(tokens.success, tokens));
    expect(style.getPropertyValue('--danger-text')).toBe(readableTextColor(tokens.danger, tokens));
    expect(style.getPropertyValue('--warning-text')).toBe(readableTextColor(tokens.warning, tokens));
  });

  it('applies the active theme from bootstrap theme state', () => {
    const activeTheme = applyThemeState({
      activeThemeId: 'custom-theme',
      themes: [
        { id: 'other-theme', name: 'Other Theme', builtIn: true, tokens },
        {
          id: 'custom-theme',
          name: 'Custom Theme',
          builtIn: false,
          tokens: { ...tokens, bg: '#abcdef', accent: '#fedcba', fontSerif: undefined }
        }
      ]
    });

    expect(activeTheme?.id).toBe('custom-theme');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#abcdef');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#fedcba');
    expect(document.documentElement.style.getPropertyValue('--font-serif')).toBe('');
  });

  it('derives readable button text colors for every built-in filled button background', () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const backgroundToken of ['accent', 'success', 'danger', 'warning'] as const) {
        const textColor = readableTextColor(theme.tokens[backgroundToken], theme.tokens);
        const ratio = contrastRatio(textColor, theme.tokens[backgroundToken]);

        expect(ratio, `${theme.id} ${backgroundToken}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
