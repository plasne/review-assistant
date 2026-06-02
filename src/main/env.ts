import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { logInfo } from '../shared/logging';
import type { AppConfig, BackendKind } from '../shared/types';

const SECRET_KEYS = new Set(['AZURE_STORAGE_ACCOUNT_CONNSTRING']);
const BACKEND_KEYS = ['AZURE_STORAGE_ACCOUNT_CONNSTRING', 'AZURE_STORAGE_ACCOUNT_NAME', 'LOCAL_PATH'];

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
  process.env.REVIEW_ASSISTANT_APP_ENV ?? path.resolve(process.cwd(), '.env');

export const loadAppConfig = (envPath = getAppEnvPath()): AppConfig => {
  const values = readEnvFile(envPath);
  const backendKind = selectBackend(values);
  logInfo('review-assistant.config', {
    source: envPath,
    backendKind,
    values: redactConfig(values)
  });
  return { backendKind, values, appEnvPath: envPath };
};

export const loadProjectEnv = (projectEnvPath: string, appValues: Record<string, string>, options: { log?: boolean } = {}): Record<string, string> => {
  const projectValues = readEnvFile(projectEnvPath);
  const backendOverrides = BACKEND_KEYS.filter((key) => key in projectValues);
  if (backendOverrides.length > 0) {
    throw new ConfigError(`Project .env cannot override backend selection keys in v0.1.0: ${backendOverrides.join(', ')}`);
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
