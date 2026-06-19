import os from 'node:os';
import path from 'node:path';

export const copilotHome = (env: NodeJS.ProcessEnv = process.env): string => env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');

export const copilotHomeSource = (env: NodeJS.ProcessEnv = process.env): 'env' | 'default-copilot-home' =>
  env.COPILOT_HOME ? 'env' : 'default-copilot-home';
