import type { Theme, ThemeState, ThemeTokens } from '../shared/types';

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
};

export const applyThemeState = (themeState: ThemeState): Theme | undefined => {
  const activeTheme = getActiveTheme(themeState);
  if (activeTheme) {
    applyTheme(activeTheme.tokens);
  }
  return activeTheme;
};
