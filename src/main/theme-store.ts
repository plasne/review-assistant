import fs from 'node:fs/promises';
import path from 'node:path';
import type { Theme, ThemeState, ThemeTokens } from '../shared/types';
import { assertTheme, assertThemeId, assertThemeState, ValidationError } from '../shared/validators';
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from './themes/built-in';

type PersistedThemeTokens = {
  bg: string;
  bg_2: string;
  surface: string;
  surface_2: string;
  border: string;
  text: string;
  text_dim: string;
  accent: string;
  accent_2: string;
  success: string;
  warning: string;
  danger: string;
  focus_ring: string;
  font_sans: string;
  font_serif?: string;
};

type PersistedTheme = {
  id: string;
  name: string;
  built_in: boolean;
  tokens: PersistedThemeTokens;
};

type PersistedThemeState = {
  active_theme_id: string;
  themes: PersistedTheme[];
};

type ThemeStoreOptions = {
  statePath?: string;
  userDataPath?: string;
  builtInThemes?: Theme[];
};

const THEME_STATE_FILE = 'themes.json';
const PERSISTED_THEME_TOKEN_KEYS = [
  'bg',
  'bg_2',
  'surface',
  'surface_2',
  'border',
  'text',
  'text_dim',
  'accent',
  'accent_2',
  'success',
  'warning',
  'danger',
  'focus_ring',
  'font_sans'
] as const satisfies readonly (keyof PersistedThemeTokens)[];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneTheme = (theme: Theme): Theme => ({
  id: theme.id,
  name: theme.name,
  builtIn: theme.builtIn,
  tokens: { ...theme.tokens }
});

const cloneState = (state: ThemeState): ThemeState => ({
  activeThemeId: state.activeThemeId,
  themes: state.themes.map(cloneTheme)
});

const toPersistedThemeTokens = (tokens: ThemeTokens): PersistedThemeTokens => ({
  bg: tokens.bg,
  bg_2: tokens.bg2,
  surface: tokens.surface,
  surface_2: tokens.surface2,
  border: tokens.border,
  text: tokens.text,
  text_dim: tokens.textDim,
  accent: tokens.accent,
  accent_2: tokens.accent2,
  success: tokens.success,
  warning: tokens.warning,
  danger: tokens.danger,
  focus_ring: tokens.focusRing,
  font_sans: tokens.fontSans,
  ...(tokens.fontSerif === undefined ? {} : { font_serif: tokens.fontSerif })
});

const fromPersistedThemeTokens = (value: unknown): ThemeTokens => {
  if (!isRecord(value)) {
    throw new ValidationError('Invalid persisted theme tokens.');
  }
  for (const key of PERSISTED_THEME_TOKEN_KEYS) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new ValidationError(`Persisted theme token ${key} must be a non-empty string.`);
    }
  }
  if (value.font_serif !== undefined && (typeof value.font_serif !== 'string' || value.font_serif.trim() === '')) {
    throw new ValidationError('Persisted theme token font_serif must be a non-empty string when provided.');
  }
  const tokens = value as Record<(typeof PERSISTED_THEME_TOKEN_KEYS)[number], string> & { font_serif?: string };
  return {
    bg: tokens.bg,
    bg2: tokens.bg_2,
    surface: tokens.surface,
    surface2: tokens.surface_2,
    border: tokens.border,
    text: tokens.text,
    textDim: tokens.text_dim,
    accent: tokens.accent,
    accent2: tokens.accent_2,
    success: tokens.success,
    warning: tokens.warning,
    danger: tokens.danger,
    focusRing: tokens.focus_ring,
    fontSans: tokens.font_sans,
    ...(tokens.font_serif === undefined ? {} : { fontSerif: tokens.font_serif })
  };
};

export const toPersistedThemeState = (state: ThemeState): PersistedThemeState => {
  const validState = assertThemeState(state);
  return {
    active_theme_id: validState.activeThemeId,
    themes: validState.themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      built_in: theme.builtIn,
      tokens: toPersistedThemeTokens(theme.tokens)
    }))
  };
};

const mapPersistedThemeState = (state: unknown): ThemeState => {
  if (!isRecord(state)) {
    throw new ValidationError('Invalid persisted theme state.');
  }
  const persisted = state as Partial<PersistedThemeState>;
  if (!Array.isArray(persisted.themes)) {
    throw new ValidationError('Invalid persisted theme state.');
  }
  const themes = persisted.themes.map((theme) => {
    if (!isRecord(theme)) {
      throw new ValidationError('Invalid persisted theme.');
    }
    return assertTheme({
      id: theme.id,
      name: theme.name,
      builtIn: theme.built_in,
      tokens: fromPersistedThemeTokens(theme.tokens)
    });
  });
  const ids = new Set<string>();
  for (const theme of themes) {
    if (ids.has(theme.id)) {
      throw new ValidationError('Theme identifiers must be unique.');
    }
    ids.add(theme.id);
  }
  return {
    activeThemeId: assertThemeId(persisted.active_theme_id),
    themes
  };
};

export const fromPersistedThemeState = (state: unknown): ThemeState => {
  const mapped = mapPersistedThemeState(state);
  return assertThemeState({
    activeThemeId: mapped.activeThemeId,
    themes: mapped.themes
  });
};

export class ThemeStore {
  private readonly statePath: string;
  private readonly builtInThemes: Theme[];
  private state: ThemeState | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ThemeStoreOptions = {}) {
    if (!options.statePath && !options.userDataPath) {
      throw new Error('Theme store requires a userDataPath or statePath.');
    }
    this.statePath = options.statePath ?? path.join(options.userDataPath as string, THEME_STATE_FILE);
    this.builtInThemes = (options.builtInThemes ?? BUILT_IN_THEMES).map(cloneTheme);
  }

  async getState(): Promise<ThemeState> {
    return this.runExclusive(async () => {
      if (!this.state) {
        this.state = await this.load();
        await this.persist();
      }
      return cloneState(this.state);
    });
  }

  async saveTheme(theme: Theme): Promise<ThemeState> {
    const validTheme = assertTheme(theme);
    if (validTheme.builtIn || this.isBuiltInTheme(validTheme.id)) {
      throw new Error('Built-in themes cannot be overwritten.');
    }
    return this.runExclusive(async () => {
      const state = await this.getMutableState();
      const existingIndex = state.themes.findIndex((candidate) => candidate.id === validTheme.id);
      if (existingIndex === -1) {
        state.themes.push(validTheme);
      } else {
        state.themes[existingIndex] = validTheme;
      }
      await this.persist();
      return cloneState(state);
    });
  }

  async deleteTheme(themeId: string): Promise<ThemeState> {
    const validThemeId = assertThemeId(themeId);
    if (this.isBuiltInTheme(validThemeId)) {
      throw new Error('Built-in themes cannot be deleted.');
    }
    return this.runExclusive(async () => {
      const state = await this.getMutableState();
      state.themes = state.themes.filter((theme) => theme.id !== validThemeId);
      if (state.activeThemeId === validThemeId) {
        state.activeThemeId = DEFAULT_THEME_ID;
      }
      await this.persist();
      return cloneState(state);
    });
  }

  async setActiveTheme(themeId: string): Promise<ThemeState> {
    const validThemeId = assertThemeId(themeId);
    return this.runExclusive(async () => {
      const state = await this.getMutableState();
      if (!state.themes.some((theme) => theme.id === validThemeId)) {
        throw new Error('Active theme identifier must reference an available theme.');
      }
      state.activeThemeId = validThemeId;
      await this.persist();
      return cloneState(state);
    });
  }

  private async getMutableState(): Promise<ThemeState> {
    if (!this.state) {
      this.state = await this.load();
    }
    return this.state;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async load(): Promise<ThemeState> {
    let persistedState: ThemeState | undefined;
    try {
      persistedState = mapPersistedThemeState(JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const customThemes = (persistedState?.themes ?? []).filter((theme) => !this.isBuiltInTheme(theme.id) && !theme.builtIn);
    const themes = [...this.builtInThemes.map(cloneTheme), ...customThemes.map(cloneTheme)];
    const candidateActiveThemeId = persistedState?.activeThemeId ?? DEFAULT_THEME_ID;
    const activeThemeId = themes.some((theme) => theme.id === candidateActiveThemeId) ? candidateActiveThemeId : DEFAULT_THEME_ID;
    return assertThemeState({ activeThemeId, themes });
  }

  private async persist(): Promise<void> {
    if (!this.state) {
      return;
    }
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, `${JSON.stringify(toPersistedThemeState(this.state), null, 2)}\n`);
  }

  private isBuiltInTheme(themeId: string): boolean {
    return this.builtInThemes.some((theme) => theme.id === themeId);
  }
}
