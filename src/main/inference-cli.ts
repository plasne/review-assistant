import path from 'node:path';
import { logInfo } from '../shared/logging';
import type { AppConfig } from '../shared/types';
import { parseAgentSettings, readEnvFile, redactConfig, selectBackend } from './env';
import { AzureInferenceArtifactWriter, runInference } from './inference';

export const getInferenceAppEnvPath = (repoRoot: string): string =>
  path.join(repoRoot, 'ground-truth', 'config', '.env');

const requireConfigValue = (values: Record<string, string>, name: string): string => {
  const value = values[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required for inference runs.`);
  }
  return value;
};

const parseIterations = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') {
    return 1;
  }
  const iterations = Number(value);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('ITERATIONS must be a positive integer.');
  }
  return iterations;
};

export const resolveInferenceIterations = (
  configValues: Record<string, string>,
  envValues: Record<string, string | undefined> = process.env
): number => parseIterations(envValues.ITERATIONS ?? configValues.ITERATIONS);

export const getInferenceLocalPath = (repoRoot: string): string =>
  path.join(repoRoot, 'ground-truth');

export const resolveInferenceCliConfig = (repoRoot: string, envValues: Record<string, string | undefined> = process.env): AppConfig => {
  const appEnvPath = getInferenceAppEnvPath(repoRoot);
  const fileValues = readEnvFile(appEnvPath);
  const values = {
    ...fileValues,
    ...(envValues.INFERENCE_RESCUE_STRATEGY ? { INFERENCE_RESCUE_STRATEGY: envValues.INFERENCE_RESCUE_STRATEGY } : {}),
    LOCAL_PATH: getInferenceLocalPath(repoRoot)
  };
  const backendKind = selectBackend(values);
  const config: AppConfig = {
    backendKind,
    values,
    appEnvPath,
    agentSettings: parseAgentSettings(values)
  };
  logInfo('review-assistant.config', {
    source: appEnvPath,
    backendKind,
    values: redactConfig(values)
  });
  return config;
};

const main = async (): Promise<void> => {
  const repoRoot = path.resolve(__dirname, '../..');
  const config = resolveInferenceCliConfig(repoRoot);
  const runFolder = String(Date.now());
  const iterations = resolveInferenceIterations(config.values);
  const containerName = requireConfigValue(config.values, 'INFERENCE_CONTAINER');
  const result = await runInference({
    repoRoot,
    runFolder,
    iterations,
    appConfigValues: config.values,
    artifactWriter: new AzureInferenceArtifactWriter(config, { containerName })
  });
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
};

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
