import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { logInfo } from '../shared/logging';
import type { AppConfig, BackendKind } from '../shared/types';
import { AgentSettingsError, parseAgentSettingsFromEnvValues } from '../shared/agent-settings';

const SECRET_KEYS = new Set(['AZURE_STORAGE_ACCOUNT_CONNSTRING']);
const BACKEND_KEYS = ['AZURE_STORAGE_ACCOUNT_CONNSTRING', 'AZURE_STORAGE_ACCOUNT_NAME', 'AZURE_STORAGE_CONTAINER', 'LOCAL_PATH'];
export const DEFAULT_COPILOT_STATUS_TIMEOUT_MS = 30_000;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const parseEnv = (content: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      throw new ConfigError(`Invalid .env line: ${rawLine}`);
    }
    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new ConfigError(`Invalid environment variable name: ${key}`);
    }
    values[key] = stripQuotes(rawValue);
  }
  return values;
};

export const readEnvFile = (envPath: string): Record<string, string> => {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  if (fs.lstatSync(envPath).isSymbolicLink()) {
    throw new ConfigError(`Environment file cannot be a symlink: ${envPath}`);
  }
  return parseEnv(fs.readFileSync(envPath, 'utf8'));
};

export const redactConfig = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, isSecretKey(key) ? '****' : value]));

const isSecretKey = (key: string): boolean => SECRET_KEYS.has(key) || /(?:TOKEN|SECRET|PASSWORD|CONNSTRING)$/i.test(key);

export const selectBackend = (values: Record<string, string>): BackendKind => {
  if (values.AZURE_STORAGE_ACCOUNT_CONNSTRING) {
    return 'azure-connection-string';
  }
  if (values.AZURE_STORAGE_ACCOUNT_NAME) {
    return 'azure-default-credential';
  }
  if (values.LOCAL_PATH) {
    return 'local';
  }
  throw new ConfigError('No supported backend configured. Set AZURE_STORAGE_ACCOUNT_CONNSTRING, AZURE_STORAGE_ACCOUNT_NAME, or LOCAL_PATH.');
};

export const getAppEnvPath = (): string =>
  path.resolve(process.env.REVIEW_ASSISTANT_APP_ENV ?? path.join(process.cwd(), '.env'));

export const loadAppConfig = (envPath = getAppEnvPath()): AppConfig => {
  const sourceEnvPath = path.resolve(envPath);
  const bootstrapValues = readEnvFile(sourceEnvPath);
  const backendKind = selectBackend(bootstrapValues);
  if (backendKind !== 'local' && !bootstrapValues.AZURE_STORAGE_CONTAINER?.trim()) {
    throw new ConfigError('AZURE_STORAGE_CONTAINER is required for Azure Blob storage.');
  }
  const localPath = bootstrapValues.LOCAL_PATH ? resolveEnvRelativePath(bootstrapValues.LOCAL_PATH, sourceEnvPath) : undefined;
  const backendValues = backendKind === 'local' && localPath ? { ...bootstrapValues, LOCAL_PATH: localPath } : bootstrapValues;
  const appEnvPath = backendKind === 'local' && localPath ? path.join(localPath, 'config', '.env') : sourceEnvPath;
  const appValues = backendKind === 'local' && path.resolve(appEnvPath) !== sourceEnvPath ? readAppEnvFile(appEnvPath) : {};
  const values = { ...backendValues, ...appValues };
  const agentSettings = parseAgentSettings(values);
  const copilotStatusTimeoutMs = parseCopilotStatusTimeoutMs(values);
  logInfo('review-assistant.config', {
    source: appEnvPath,
    backendKind,
    values: redactConfig(values)
  });
  return { backendKind, values, appEnvPath, agentSettings, copilotStatusTimeoutMs };
};

const resolveEnvRelativePath = (value: string, envPath: string): string =>
  path.resolve(path.isAbsolute(value) ? value : path.join(path.dirname(envPath), value));

const readAppEnvFile = (appEnvPath: string): Record<string, string> => {
  const values = readEnvFile(appEnvPath);
  const backendOverrides = BACKEND_KEYS.filter((key) => key in values);
  if (backendOverrides.length > 0) {
    throw new ConfigError(`App config/.env cannot override backend selection keys: ${backendOverrides.join(', ')}`);
  }
  return values;
};

export const parseAgentSettings = (values: Record<string, string | undefined>) => {
  try {
    return parseAgentSettingsFromEnvValues(values);
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      throw new ConfigError(error.message);
    }
    throw error;
  }
};

export const parseCopilotStatusTimeoutMs = (values: Record<string, string | undefined>): number => {
  const rawValue = values.COPILOT_STATUS_TIMEOUT_SECONDS?.trim();
  if (!rawValue) {
    return DEFAULT_COPILOT_STATUS_TIMEOUT_MS;
  }
  const timeoutSeconds = Number(rawValue);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ConfigError('COPILOT_STATUS_TIMEOUT_SECONDS must be a positive number of seconds.');
  }
  return Math.round(timeoutSeconds * 1000);
};

export const loadProjectEnv = (projectEnvPath: string, appValues: Record<string, string>, options: { log?: boolean } = {}): Record<string, string> => {
  const projectValues = readEnvFile(projectEnvPath);
  const backendOverrides = BACKEND_KEYS.filter((key) => key in projectValues);
  if (backendOverrides.length > 0) {
    throw new ConfigError(`Project config/.env cannot override backend selection keys in v0.1.0: ${backendOverrides.join(', ')}`);
  }
  const merged = { ...appValues, ...projectValues };
  if (options.log !== false) {
    logInfo('review-assistant.project-config', {
      source: projectEnvPath,
      values: redactConfig(merged)
    });
  }
  return merged;
};

const stripQuotes = (value: string): string => {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};
