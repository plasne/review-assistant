import type { Theme, ThemeTokens } from '../../shared/types';

const systemSans = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const defaultThemeTokens: ThemeTokens = {
  bg: '#101827',
  bg2: '#0d1320',
  surface: '#182338',
  surface2: '#27344d',
  border: '#30415f',
  text: '#f4f7fb',
  textDim: '#aebbd0',
  accent: '#0969da',
  accent2: '#58a6ff',
  success: '#2f6f4f',
  warning: '#ffd166',
  danger: '#ff9aa8',
  focusRing: '#8bd3ff',
  fontSans: systemSans
} as const;

export const DEFAULT_THEME_ID = 'default';

export const BUILT_IN_THEMES: Theme[] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'Default',
    builtIn: true,
    tokens: defaultThemeTokens
  },
  {
    id: 'midnight',
    name: 'Midnight',
    builtIn: true,
    tokens: {
      ...defaultThemeTokens
    }
  },
  {
    id: 'editorial-atelier',
    name: 'Editorial Atelier',
    builtIn: true,
    tokens: {
      bg: '#f4ece0',
      bg2: '#ece1d1',
      surface: '#fbf6ee',
      surface2: '#f7efe3',
      border: '#d8cfc0',
      text: '#1c1a17',
      textDim: '#5c554c',
      accent: '#9a3412',
      accent2: '#1e5b4f',
      success: '#1e5b4f',
      warning: '#a8761f',
      danger: '#b4533a',
      focusRing: '#9a3412',
      fontSans: '"Newsreader", Georgia, serif',
      fontSerif: '"Fraunces", Georgia, serif'
    }
  },
  {
    id: 'signal-terminal',
    name: 'Signal Terminal',
    builtIn: true,
    tokens: {
      bg: '#0a0e0d',
      bg2: '#16201d',
      surface: '#0e1413',
      surface2: '#121a18',
      border: '#1f2c28',
      text: '#c8d6cf',
      textDim: '#6f8178',
      accent: '#39ff7a',
      accent2: '#28e0c8',
      success: '#39ff7a',
      warning: '#ffb000',
      danger: '#ff5d5d',
      focusRing: '#28e0c8',
      fontSans: '"IBM Plex Mono", ui-monospace, monospace',
      fontSerif: '"IBM Plex Sans", system-ui, sans-serif'
    }
  },
  {
    id: 'aurora-glass',
    name: 'Aurora Glass',
    builtIn: true,
    tokens: {
      bg: '#070b16',
      bg2: '#0b1024',
      surface: 'rgba(20,28,54,.92)',
      surface2: 'rgba(30,40,72,.86)',
      border: 'rgba(140,170,255,.28)',
      text: '#e8eefc',
      textDim: '#9aa8cf',
      accent: '#34e6c5',
      accent2: '#8b8bff',
      success: '#34e6c5',
      warning: '#f0c66b',
      danger: '#ff8aa6',
      focusRing: 'rgba(140,200,255,.7)',
      fontSans: '"Manrope", system-ui, sans-serif',
      fontSerif: '"Syne", system-ui, sans-serif'
    }
  },
  {
    id: 'neon-drive',
    name: 'Neon Drive',
    builtIn: true,
    tokens: {
      bg: '#0d0420',
      bg2: '#160833',
      surface: 'rgba(28,10,58,.88)',
      surface2: '#241047',
      border: '#3a1c6e',
      text: '#eadcff',
      textDim: '#9a86c9',
      accent: '#ff2db8',
      accent2: '#19f0ff',
      success: '#b6ff3d',
      warning: '#ffcf3d',
      danger: '#ff5d9e',
      focusRing: '#19f0ff',
      fontSans: '"Rajdhani", sans-serif',
      fontSerif: '"Chakra Petch", sans-serif'
    }
  },
  {
    id: 'quiet-study',
    name: 'Quiet Study',
    builtIn: true,
    tokens: {
      bg: '#f3efe6',
      bg2: '#ece6d9',
      surface: '#fbf9f3',
      surface2: '#f6f2e8',
      border: '#e2dac9',
      text: '#2f2a24',
      textDim: '#7a7064',
      accent: '#6f8b6a',
      accent2: '#c2734a',
      success: '#4e6a4a',
      warning: '#c79a45',
      danger: '#a25068',
      focusRing: '#6f8b6a',
      fontSans: '"Spline Sans", system-ui, sans-serif',
      fontSerif: '"Instrument Serif", Georgia, serif'
    }
  },
  {
    id: 'att-cyber-futurism',
    name: 'AT&T Cyber-Futurism',
    builtIn: true,
    tokens: {
      bg: '#03070f',
      bg2: '#06101f',
      surface: 'rgba(8,20,38,.92)',
      surface2: 'rgba(12,28,52,.86)',
      border: 'rgba(0,159,219,.34)',
      text: '#dff1fb',
      textDim: '#7fa6c4',
      accent: '#009fdb',
      accent2: '#3ec6ff',
      success: '#5ff0b0',
      warning: '#ffb547',
      danger: '#ff5e7a',
      focusRing: 'rgba(0,200,255,.72)',
      fontSans: '"Archivo", system-ui, sans-serif',
      fontSerif: '"Orbitron", system-ui, sans-serif'
    }
  },
  {
    id: 'endurance',
    name: 'Endurance',
    builtIn: true,
    tokens: {
      bg: '#1c1915',
      bg2: '#211d18',
      surface: '#26221c',
      surface2: '#2d281f',
      border: '#3a342a',
      text: '#ece3d2',
      textDim: '#998c75',
      accent: '#d9a85c',
      accent2: '#cd8163',
      success: '#8fae7e',
      warning: '#d9a85c',
      danger: '#cf7a83',
      focusRing: '#d9a85c',
      fontSans: '"Atkinson Hyperlegible", system-ui, sans-serif',
      fontSerif: '"Hanken Grotesk", system-ui, sans-serif'
    }
  }
];
