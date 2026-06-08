import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, Theme, ThemeState } from '../../src/shared/types';

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMock.exposeInMainWorld
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener
  }
}));

const defaultTheme: Theme = {
  id: 'default',
  name: 'Default',
  builtIn: true,
  tokens: {
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
    fontSans: 'Inter, sans-serif'
  }
};

const midnightTheme: Theme = {
  id: 'midnight',
  name: 'Midnight',
  builtIn: true,
  tokens: {
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
    fontSans: 'Inter, sans-serif'
  }
};

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

const defaultThemeState: ThemeState = {
  activeThemeId: defaultTheme.id,
  themes: [defaultTheme, midnightTheme]
};

const loadPreloadApi = async (): Promise<Api> => {
  vi.resetModules();
  await import('../../src/preload/preload');
  expect(electronMock.exposeInMainWorld).toHaveBeenCalledWith('reviewAssistant', expect.any(Object));
  return electronMock.exposeInMainWorld.mock.calls.at(-1)?.[1] as Api;
};

describe('preload theme IPC bridge', () => {
  beforeEach(() => {
    electronMock.exposeInMainWorld.mockClear();
    electronMock.invoke.mockReset();
    electronMock.on.mockClear();
    electronMock.removeListener.mockClear();
  });

  it('routes theme API methods through validated allowlisted invoke channels', async () => {
    electronMock.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'theme:save') {
        return { activeThemeId: customTheme.id, themes: [defaultTheme, midnightTheme, customTheme] };
      }
      return defaultThemeState;
    });
    const api = await loadPreloadApi();

    await expect(api.getThemeState()).resolves.toEqual(defaultThemeState);
    await expect(api.saveTheme(customTheme)).resolves.toMatchObject({ activeThemeId: customTheme.id });
    await expect(api.deleteTheme(customTheme.id)).resolves.toEqual(defaultThemeState);
    await expect(api.setActiveTheme(midnightTheme.id)).resolves.toEqual(defaultThemeState);

    expect(electronMock.invoke).toHaveBeenNthCalledWith(1, 'theme:getState');
    expect(electronMock.invoke).toHaveBeenNthCalledWith(2, 'theme:save', customTheme);
    expect(electronMock.invoke).toHaveBeenNthCalledWith(3, 'theme:delete', customTheme.id);
    expect(electronMock.invoke).toHaveBeenNthCalledWith(4, 'theme:setActive', midnightTheme.id);
  });

  it('rejects malformed theme payloads before invoking main-owned persistence', async () => {
    electronMock.invoke.mockResolvedValue(defaultThemeState);
    const api = await loadPreloadApi();

    expect(() => api.saveTheme({ ...customTheme, id: 'Bad Theme' })).toThrow(
      'Theme identifier must be 3-63 characters using lowercase letters, numbers, and hyphens.'
    );

    expect(electronMock.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed theme responses before exposing them to renderer code', async () => {
    electronMock.invoke.mockResolvedValue({ activeThemeId: 'missing-theme', themes: [defaultTheme, midnightTheme] });
    const api = await loadPreloadApi();

    await expect(api.getThemeState()).rejects.toThrow('Active theme identifier must reference an available theme.');
  });
});
