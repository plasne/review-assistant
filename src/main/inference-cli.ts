import path from 'node:path';
import { loadAppConfig } from './env';
import { AzureInferenceArtifactWriter, runInference } from './inference';

export const getInferenceAppEnvPath = (repoRoot: string, values: Record<string, string | undefined> = process.env): string =>
  values.REVIEW_ASSISTANT_APP_ENV ?? path.join(repoRoot, 'ground-truth', 'config', '.env');

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

const main = async (): Promise<void> => {
  const repoRoot = path.resolve(__dirname, '../..');
  const config = loadAppConfig(getInferenceAppEnvPath(repoRoot));
  const runFolder = String(Date.now());
  const iterations = parseIterations(process.env.ITERATIONS);
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
