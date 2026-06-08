import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Theme } from '../../src/shared/types';
import { ThemeStore, fromPersistedThemeState, toPersistedThemeState } from '../../src/main/theme-store';

const customTheme: Theme = {
  id: 'custom-focus',
  name: 'Custom Focus',
  builtIn: false,
  tokens: {
    bg: '#101010',
    bg2: '#151515',
    surface: '#202020',
    surface2: '#2a2a2a',
    border: '#404040',
    text: '#f5f5f5',
    textDim: '#bbbbbb',
    accent: '#44ccff',
    accent2: '#ffaa44',
    success: '#55cc88',
    warning: '#ffcc55',
    danger: '#ff6677',
    focusRing: '#88ddff',
    fontSans: 'Inter, sans-serif',
    fontSerif: 'Georgia, serif'
  }
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;

describe('theme store', () => {
  let tempRoot: string | undefined;

  const createStore = async (): Promise<{ store: ThemeStore; statePath: string }> => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-theme-'));
    const statePath = path.join(tempRoot, 'themes.json');
    return { store: new ThemeStore({ statePath }), statePath };
  };

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('seeds built-in themes and persists default as the active theme on first load', async () => {
    const { store, statePath } = await createStore();

    const state = await store.getState();
    const persisted = await readJson(statePath);

    expect(state.activeThemeId).toBe('default');
    expect(state.themes.map((theme) => theme.id)).toEqual([
      'default',
      'midnight',
      'editorial-atelier',
      'signal-terminal',
      'aurora-glass',
      'neon-drive',
      'quiet-study',
      'att-cyber-futurism',
      'endurance'
    ]);
    expect(persisted).toMatchObject({ active_theme_id: 'default' });
  });

  it('round-trips custom themes and maps TypeScript camelCase to persisted snake_case', async () => {
    const { store, statePath } = await createStore();

    await store.saveTheme(customTheme);
    await store.setActiveTheme(customTheme.id);
    const reloaded = new ThemeStore({ statePath });
    const state = await reloaded.getState();
    const persisted = await readJson(statePath);
    const persistedCustom = (persisted.themes as Record<string, unknown>[]).find((theme) => theme.id === customTheme.id);

    expect(state.activeThemeId).toBe(customTheme.id);
    expect(state.themes.find((theme) => theme.id === customTheme.id)).toEqual(customTheme);
    expect(persisted).toHaveProperty('active_theme_id', customTheme.id);
    expect(persisted).not.toHaveProperty('activeThemeId');
    expect(persistedCustom).toMatchObject({ built_in: false });
    expect(persistedCustom).not.toHaveProperty('builtIn');
    expect(persistedCustom?.tokens).toMatchObject({
      bg_2: customTheme.tokens.bg2,
      surface_2: customTheme.tokens.surface2,
      text_dim: customTheme.tokens.textDim,
      accent_2: customTheme.tokens.accent2,
      focus_ring: customTheme.tokens.focusRing,
      font_sans: customTheme.tokens.fontSans,
      font_serif: customTheme.tokens.fontSerif
    });
    expect(persistedCustom?.tokens).not.toHaveProperty('textDim');
  });

  it('preserves all first-use custom theme saves when operations run concurrently', async () => {
    const { store, statePath } = await createStore();
    const concurrentThemes = Array.from({ length: 8 }, (_, index): Theme => {
      const id = `custom-focus-${index}`;
      return {
        ...customTheme,
        id,
        name: `Custom Focus ${index}`,
        tokens: {
          ...customTheme.tokens,
          accent: `#44ccf${index}`
        }
      };
    });

    await Promise.all(concurrentThemes.map((theme) => store.saveTheme(theme)));

    const reloaded = await new ThemeStore({ statePath }).getState();
    expect(reloaded.themes.filter((theme) => theme.id.startsWith('custom-focus-')).map((theme) => theme.id).sort()).toEqual(
      concurrentThemes.map((theme) => theme.id).sort()
    );
  });

  it('prevents overwriting or deleting built-in themes', async () => {
    const { store } = await createStore();

    await expect(store.saveTheme({ ...customTheme, id: 'midnight' })).rejects.toThrow('Built-in themes cannot be overwritten');
    await expect(store.deleteTheme('midnight')).rejects.toThrow('Built-in themes cannot be deleted');
  });

  it('falls back to default when persisted active theme is no longer available', async () => {
    const { statePath } = await createStore();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        ...toPersistedThemeState({ activeThemeId: customTheme.id, themes: [customTheme] }),
        active_theme_id: 'missing-theme',
        themes: []
      })}\n`
    );

    const state = await new ThemeStore({ statePath }).getState();

    expect(state.activeThemeId).toBe('default');
    expect(state.themes.every((theme) => theme.builtIn)).toBe(true);
  });

  it('maps persisted snake_case theme state back to camelCase domain objects', () => {
    expect(
      fromPersistedThemeState({
        active_theme_id: customTheme.id,
        themes: [toPersistedThemeState({ activeThemeId: customTheme.id, themes: [customTheme] }).themes[0]]
      })
    ).toEqual({ activeThemeId: customTheme.id, themes: [customTheme] });
  });
});
