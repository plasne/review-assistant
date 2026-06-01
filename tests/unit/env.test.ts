import { describe, expect, it } from 'vitest';
import { parseEnv, redactConfig, selectBackend } from '../../src/main/env';

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
    expect(redactConfig({ AZURE_STORAGE_ACCOUNT_CONNSTRING: 'secret', LOCAL_PATH: '/tmp/projects' })).toEqual({
      AZURE_STORAGE_ACCOUNT_CONNSTRING: '****',
      LOCAL_PATH: '/tmp/projects'
    });
  });

});
