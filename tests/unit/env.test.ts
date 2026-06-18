import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COPILOT_STATUS_TIMEOUT_MS,
  loadAppConfig,
  parseAgentSettings,
  parseCopilotStatusTimeoutMs,
  parseEnv,
  redactConfig,
  selectBackend
} from '../../src/main/env';

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

  it('resolves local app-level config under LOCAL_PATH', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-env-'));
    try {
      const localPath = path.join(tempRoot, 'data');
      const bootstrapEnvPath = path.join(tempRoot, '.env');
      const appEnvPath = path.join(localPath, 'config', '.env');
      await fs.mkdir(path.dirname(appEnvPath), { recursive: true });
      await fs.writeFile(bootstrapEnvPath, 'LOCAL_PATH=data\n');
      await fs.writeFile(appEnvPath, 'USERNAME=app@example.com\n');

      const config = loadAppConfig(bootstrapEnvPath);

      expect(config).toMatchObject({
        backendKind: 'local',
        values: { LOCAL_PATH: localPath, USERNAME: 'app@example.com' },
        appEnvPath: path.join(localPath, 'config', '.env')
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('blocks backend overrides from local app-level config', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-env-'));
    try {
      const localPath = path.join(tempRoot, 'data');
      const bootstrapEnvPath = path.join(tempRoot, '.env');
      const appEnvPath = path.join(localPath, 'config', '.env');
      await fs.mkdir(path.dirname(appEnvPath), { recursive: true });
      await fs.writeFile(bootstrapEnvPath, 'LOCAL_PATH=data\n');
      await fs.writeFile(appEnvPath, 'LOCAL_PATH=/tmp/other\n');

      expect(() => loadAppConfig(bootstrapEnvPath)).toThrow('App config/.env cannot override backend selection keys: LOCAL_PATH');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('redacts secret values in logs', () => {
    expect(redactConfig({ AZURE_STORAGE_ACCOUNT_CONNSTRING: 'secret', SOURCE_TOKEN: 'source-secret', LOCAL_PATH: '/tmp/projects' })).toEqual({
      AZURE_STORAGE_ACCOUNT_CONNSTRING: '****',
      SOURCE_TOKEN: '****',
      LOCAL_PATH: '/tmp/projects'
    });
  });

  it('requires an Azure storage container for blob-backed projects', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-env-'));
    try {
      const envPath = path.join(tempRoot, '.env');
      await fs.writeFile(envPath, 'AZURE_STORAGE_ACCOUNT_NAME=account\n');

      expect(() => loadAppConfig(envPath)).toThrow('AZURE_STORAGE_CONTAINER is required for Azure Blob storage.');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
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

  it('defaults and parses the Copilot status timeout from app env values', () => {
    expect(parseCopilotStatusTimeoutMs({})).toBe(DEFAULT_COPILOT_STATUS_TIMEOUT_MS);
    expect(parseCopilotStatusTimeoutMs({ COPILOT_STATUS_TIMEOUT_SECONDS: '30' })).toBe(30000);
    expect(parseCopilotStatusTimeoutMs({ COPILOT_STATUS_TIMEOUT_SECONDS: '2.5' })).toBe(2500);
  });

  it('rejects invalid Copilot status timeout values', () => {
    expect(() => parseCopilotStatusTimeoutMs({ COPILOT_STATUS_TIMEOUT_SECONDS: '0' })).toThrow(
      'COPILOT_STATUS_TIMEOUT_SECONDS must be a positive number of seconds.'
    );
    expect(() => parseCopilotStatusTimeoutMs({ COPILOT_STATUS_TIMEOUT_SECONDS: 'soon' })).toThrow(
      'COPILOT_STATUS_TIMEOUT_SECONDS must be a positive number of seconds.'
    );
  });

  it('rejects invalid agent settings with config errors', () => {
    expect(() => parseAgentSettings({ REASONING_EFFORT: 'extreme' })).toThrow(
      'REASONING_EFFORT must be one of: low, medium, high, xhigh.'
    );
  });
});
