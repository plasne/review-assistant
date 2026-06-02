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
  const searchPaths = options.searchPaths ?? requireFromHere.resolve.paths('@github/copilot') ?? [];

  for (const basePath of searchPaths) {
    for (const platformName of copilotPlatformNames(platform)) {
      const binary = path.join(basePath, '@github', `copilot-${platformName}-${arch}`, copilotBinaryName(platform));
      if (exists(binary)) {
        return binary;
      }
    }
  }

  throw new Error('GitHub Copilot runtime was not found. Ensure @github/copilot is installed with its platform runtime package.');
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
