import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type ResolveOptions = {
  arch?: NodeJS.Architecture;
  exists?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
  searchPaths?: string[];
};

const requireFromHere = createRequire(__filename);

export const resolveCopilotRuntimePath = (options: ResolveOptions = {}): string => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const candidates = listCopilotRuntimeCandidates({ platform, arch, searchPaths: options.searchPaths });

  for (const binary of candidates) {
    if (exists(binary)) {
      return binary;
    }
  }

  const searched = candidates.length > 0 ? candidates.join('; ') : 'no package search paths were available';
  throw new Error(
    `GitHub Copilot runtime was not found for ${platform}/${arch}. Searched: ${searched}. Ensure @github/copilot is installed with its platform runtime package or set COPILOT_RUNTIME_COMMAND in the root app .env.`
  );
};

export const listCopilotRuntimeCandidates = (options: Omit<ResolveOptions, 'exists'> = {}): string[] => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const searchPaths = options.searchPaths ?? requireFromHere.resolve.paths('@github/copilot') ?? [];
  return searchPaths.flatMap((basePath) =>
    copilotPlatformNames(platform).map((platformName) =>
      path.join(basePath, '@github', `copilot-${platformName}-${arch}`, copilotBinaryName(platform))
    )
  );
};

const copilotBinaryName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'copilot.exe' : 'copilot');

const copilotPlatformNames = (platform: NodeJS.Platform): string[] => {
  if (platform === 'linux') {
    return ['linux', 'linuxmusl'];
  }
  if (platform === 'darwin' || platform === 'win32') {
    return [platform];
  }
  return [];
};
