import { describe, expect, it } from 'vitest';
import { displayConfigEntryForPath, normalizeDisplayConfig } from '../../src/shared/display';

describe('display config helpers', () => {
  it('normalizes known field presentations and matches array wildcards', () => {
    const config = normalizeDisplayConfig({
      properties: {
        '/turns/*/request': { path: '/turns/*/request', presentation: 'chat-request' },
        '/turns/*/response': { presentation: 'chat-response' },
        '/turns/*/evidence': { path: '/turns/*/evidence', presentation: 'evidence-list' },
        '/turns/*/evidence/*/content': { path: '/turns/*/evidence/*/content', presentation: 'diff-view' },
        '/turns/*/ignored': { path: '/turns/*/ignored', presentation: 'unknown' },
        '/blank': { path: ' ', presentation: 'chat-request' }
      }
    });

    expect(config.properties).toEqual({
      '/turns/*/request': { path: '/turns/*/request', presentation: 'chat-request' },
      '/turns/*/response': { path: '/turns/*/response', presentation: 'chat-response' },
      '/turns/*/evidence': { path: '/turns/*/evidence', presentation: 'evidence-list' },
      '/turns/*/evidence/*/content': { path: '/turns/*/evidence/*/content', presentation: 'diff-view' }
    });
    expect(displayConfigEntryForPath(config, '/turns/0/request')).toMatchObject({ presentation: 'chat-request' });
    expect(displayConfigEntryForPath(config, '/turns/12/response')).toMatchObject({ presentation: 'chat-response' });
    expect(displayConfigEntryForPath(config, '/turns/12/evidence')).toMatchObject({ presentation: 'evidence-list' });
    expect(displayConfigEntryForPath(config, '/turns/12/evidence/3/content')).toMatchObject({ presentation: 'diff-view' });
    expect(displayConfigEntryForPath(config, '/turns/latest/request')).toBeUndefined();
  });

  it('ignores missing or malformed config', () => {
    expect(normalizeDisplayConfig(undefined)).toEqual({ properties: {} });
    expect(normalizeDisplayConfig({ properties: [] })).toEqual({ properties: {} });
  });
});
