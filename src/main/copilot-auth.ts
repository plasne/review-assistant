import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ContinueWithGitHubResult, GitHubLoginCompletion } from '../shared/types';
import { copilotHome, copilotHomeSource } from './copilot-home';
import { resolveCopilotRuntimePath } from './copilot-runtime';

const LOGIN_CODE_TIMEOUT_MS = 15000;

type LoginProcess = {
  kill: () => boolean;
  once: {
    (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): LoginProcess;
    (event: 'error', listener: (error: Error) => void): LoginProcess;
  };
  stderr?: NodeJS.ReadableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  unref: () => void;
};

type SpawnLoginProcess = (
  command: string,
  args: string[],
  options: { detached: boolean; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }
) => LoginProcess;

export type StartCopilotLoginOptions = {
  loginId?: string;
  log?: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void;
  onComplete?: (completion: GitHubLoginCompletion) => void;
  resolveRuntimePath?: () => string;
  spawnProcess?: SpawnLoginProcess;
  timeoutMs?: number;
};

export const startCopilotLogin = async (options: StartCopilotLoginOptions = {}): Promise<ContinueWithGitHubResult> => {
  const command = (options.resolveRuntimePath ?? resolveCopilotRuntimePath)();
  const home = copilotHome();
  const loginId = options.loginId ?? randomUUID();
  const spawnProcess = options.spawnProcess ?? spawnLoginProcess;
  const timeoutMs = options.timeoutMs ?? LOGIN_CODE_TIMEOUT_MS;
  options.log?.('info', 'review-assistant.auth-login-command', {
    loginId,
    command,
    copilotHome: home,
    copilotHomeSource: copilotHomeSource(),
    timeoutMs
  });
  return await new Promise<ContinueWithGitHubResult>((resolve, reject) => {
    const child = spawnProcess(command, ['login'], {
      detached: true,
      env: { ...process.env, COPILOT_HOME: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let resultSettled = false;
    let deviceCodeDelivered = false;
    let completionDelivered = false;
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error('Timed out waiting for GitHub Copilot device login code.'));
    }, timeoutMs);
    const settle = (result: ContinueWithGitHubResult): void => {
      if (resultSettled) {
        return;
      }
      resultSettled = true;
      deviceCodeDelivered = Boolean(result.deviceCode);
      clearTimeout(timeout);
      child.unref();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (resultSettled) {
        return;
      }
      resultSettled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const complete = (completion: Omit<GitHubLoginCompletion, 'loginId'>): void => {
      if (completionDelivered) {
        return;
      }
      completionDelivered = true;
      options.log?.(completion.success ? 'info' : 'error', 'review-assistant.auth-login-process-completed', {
        loginId,
        success: completion.success,
        outputChars: output.length,
        errorMessage: completion.errorMessage
      });
      options.onComplete?.({ loginId, ...completion });
    };
    const appendOutput = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const deviceLogin = parseCopilotDeviceLogin(output);
      if (deviceLogin) {
        settle({ opened: true, loginId, ...deviceLogin });
      }
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.once('error', (error) => {
      if (deviceCodeDelivered) {
        complete({ success: false, errorMessage: error.message });
        return;
      }
      fail(error);
    });
    child.once('close', (code) => {
      options.log?.(code === 0 ? 'info' : 'error', 'review-assistant.auth-login-process-exited', {
        loginId,
        code,
        deviceCodeDelivered,
        outputChars: output.length
      });
      if (code === 0) {
        if (deviceCodeDelivered) {
          complete({ success: true });
          return;
        }
        settle({ opened: true, loginId });
        return;
      }
      if (deviceCodeDelivered) {
        complete({ success: false, errorMessage: `GitHub Copilot login exited before authorization completed. Exit code: ${code ?? 'unknown'}.` });
        return;
      }
      fail(new Error(`GitHub Copilot login exited before producing a device code. Exit code: ${code ?? 'unknown'}.`));
    });
  });
};

export const parseCopilotDeviceLogin = (output: string): Pick<ContinueWithGitHubResult, 'deviceCode' | 'verificationUri'> | undefined => {
  const normalized = stripAnsi(output).replace(/\s+/g, ' ');
  const visitMatch = normalized.match(/visit\s+(https?:\/\/\S+)\s+and enter code\s+([A-Za-z0-9-]+)/i);
  if (visitMatch) {
    return { verificationUri: trimTrailingPunctuation(visitMatch[1]), deviceCode: visitMatch[2] };
  }
  const oneTimeCodeMatch = normalized.match(/Enter one-time code:\s*([A-Za-z0-9-]+)\s+at\s+(https?:\/\/\S+)/i);
  if (oneTimeCodeMatch) {
    return { deviceCode: oneTimeCodeMatch[1], verificationUri: trimTrailingPunctuation(oneTimeCodeMatch[2]) };
  }
  return undefined;
};

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, '');

const trimTrailingPunctuation = (value: string): string => value.replace(/[.,;:]+$/, '');

const spawnLoginProcess: SpawnLoginProcess = (command, args, options) => spawn(command, args, options);
