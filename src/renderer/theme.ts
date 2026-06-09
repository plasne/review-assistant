import type { Theme, ThemeState, ThemeTokens } from '../shared/types';

const DARK_BUTTON_TEXT = '#0b1220';
const LIGHT_BUTTON_TEXT = '#ffffff';

const TOKEN_TO_CSS_PROPERTY: Record<keyof ThemeTokens, string> = {
  bg: '--bg',
  bg2: '--bg-2',
  surface: '--surface',
  surface2: '--surface-2',
  border: '--border',
  text: '--text',
  textDim: '--text-dim',
  accent: '--accent',
  accent2: '--accent-2',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  focusRing: '--focus-ring',
  fontSans: '--font-sans',
  fontSerif: '--font-serif'
};

const parseHexColor = (value: string): [number, number, number] | undefined => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const numericValue = Number.parseInt(match[1], 16);
  return [(numericValue >> 16) & 255, (numericValue >> 8) & 255, numericValue & 255];
};

const linearizeRgb = (channel: number): number => {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (value: string): number | undefined => {
  const rgb = parseHexColor(value);
  if (!rgb) {
    return undefined;
  }
  const [red, green, blue] = rgb.map(linearizeRgb);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const contrastRatio = (foreground: string, background: string): number | undefined => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === undefined || backgroundLuminance === undefined) {
    return undefined;
  }
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

export const readableTextColor = (background: string, tokens: ThemeTokens): string => {
  const candidates = [tokens.text, tokens.bg, tokens.bg2, DARK_BUTTON_TEXT, LIGHT_BUTTON_TEXT];
  return candidates.reduce(
    (best, candidate) => {
      const ratio = contrastRatio(candidate, background) ?? 0;
      return ratio > best.ratio ? { color: candidate, ratio } : best;
    },
    { color: tokens.text, ratio: contrastRatio(tokens.text, background) ?? 0 }
  ).color;
};

export const getActiveTheme = (themeState: ThemeState): Theme | undefined =>
  themeState.themes.find((theme) => theme.id === themeState.activeThemeId);

export const applyTheme = (tokens: ThemeTokens): void => {
  const root = document.documentElement;
  for (const [tokenKey, cssProperty] of Object.entries(TOKEN_TO_CSS_PROPERTY)) {
    const value = tokens[tokenKey as keyof ThemeTokens];
    if (value) {
      root.style.setProperty(cssProperty, value);
    } else if (tokenKey === 'fontSerif') {
      root.style.removeProperty(cssProperty);
    }
  }
  root.style.setProperty('--accent-text', readableTextColor(tokens.accent, tokens));
  root.style.setProperty('--success-text', readableTextColor(tokens.success, tokens));
  root.style.setProperty('--danger-text', readableTextColor(tokens.danger, tokens));
  root.style.setProperty('--warning-text', readableTextColor(tokens.warning, tokens));
};

export const applyThemeState = (themeState: ThemeState): Theme | undefined => {
  const activeTheme = getActiveTheme(themeState);
  if (activeTheme) {
    applyTheme(activeTheme.tokens);
  }
  return activeTheme;
};
