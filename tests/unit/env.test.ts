import { describe, expect, it } from 'vitest';
import { parseAgentSettings, parseEnv, redactConfig, selectBackend } from '../../src/main/env';

describe('environment config', () => {
  it('parses env files without variable expansion', () => {
    expect(parseEnv('LOCAL_PATH="/tmp/projects"\n# comment\nNAME=value')).toEqual({
      LOCAL_PATH: '/tmp/projects',
      NAME: 'value'
    });
  });

  it('selects backend by required precedence', () => {
    expect(selectBackend({ LOCAL_PATH: '/tmp/projects' })).toBe('local');
    expect(selectBackend({ LOCAL_PATH: '/tmp/projects', AZURE_STORAGE_ACCOUNT_NAME: 'acct' })).toBe('azure-default-credential');
    expect(selectBackend({ AZURE_STORAGE_ACCOUNT_NAME: 'acct', AZURE_STORAGE_ACCOUNT_CONNSTRING: 'secret' })).toBe(
      'azure-connection-string'
    );
  });

  it('redacts secret values in logs', () => {
    expect(redactConfig({ AZURE_STORAGE_ACCOUNT_CONNSTRING: 'secret', SOURCE_TOKEN: 'source-secret', LOCAL_PATH: '/tmp/projects' })).toEqual({
      AZURE_STORAGE_ACCOUNT_CONNSTRING: '****',
      SOURCE_TOKEN: '****',
      LOCAL_PATH: '/tmp/projects'
    });
  });

  it('parses agent settings from app env values', () => {
    expect(
      parseAgentSettings({
        AGENT_MODEL: ' gpt-5.5 ',
        REASONING_EFFORT: 'high'
      })
    ).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'high'
    });
  });

  it('rejects invalid agent settings with config errors', () => {
    expect(() => parseAgentSettings({ REASONING_EFFORT: 'extreme' })).toThrow(
      'REASONING_EFFORT must be one of: low, medium, high, xhigh.'
    );
  });
});
