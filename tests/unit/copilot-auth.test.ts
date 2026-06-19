import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseCopilotDeviceLogin, startCopilotLogin, type StartCopilotLoginOptions } from '../../src/main/copilot-auth';
import { resolveCopilotRuntimePath } from '../../src/main/copilot-runtime';

describe('Copilot auth helpers', () => {
  it('resolves the SDK-bundled native Copilot runtime for the current platform', () => {
    const basePath = path.join('/tmp', 'node_modules');
    const command = resolveCopilotRuntimePath({
      arch: 'arm64',
      platform: 'darwin',
      searchPaths: [basePath],
      exists: (candidate) => candidate === path.join(basePath, '@github', 'copilot-darwin-arm64', 'copilot')
    });

    expect(command).toBe(path.join(basePath, '@github', 'copilot-darwin-arm64', 'copilot'));
  });

  it('prefers the unpacked native Copilot runtime when resolved from an Electron asar path', () => {
    const basePath = path.join('C:\\Users\\user\\AppData\\Local\\Programs\\Review Assistant\\resources\\app.asar', 'node_modules');
    const unpackedRuntime = path.join(
      'C:\\Users\\user\\AppData\\Local\\Programs\\Review Assistant\\resources\\app.asar.unpacked',
      'node_modules',
      '@github',
      'copilot-win32-x64',
      'copilot.exe'
    );

    const command = resolveCopilotRuntimePath({
      arch: 'x64',
      platform: 'win32',
      searchPaths: [basePath],
      exists: (candidate) => candidate === unpackedRuntime
    });

    expect(command).toBe(unpackedRuntime);
  });

  it('throws a clear error when the Copilot runtime package is unavailable', () => {
    expect(() =>
      resolveCopilotRuntimePath({
        arch: 'x64',
        platform: 'darwin',
        searchPaths: [path.join('/tmp', 'node_modules')],
        exists: () => false
      })
    ).toThrow(
      'GitHub Copilot runtime was not found for darwin/x64. Searched: /tmp/node_modules/@github/copilot-darwin-x64/copilot.'
    );
  });

  it('parses the Copilot device login code and verification URL from CLI output', () => {
    expect(
      parseCopilotDeviceLogin('To authenticate, visit https://github.com/login/device and enter code 1234-ABCD.\\nWaiting for authorization...')
    ).toEqual({
      verificationUri: 'https://github.com/login/device',
      deviceCode: '1234-ABCD'
    });
  });

  it('keeps watching the login process and reports completion after returning the device code', async () => {
    const loginProcess = createLoginProcess();
    const onComplete = vi.fn();
    const spawnProcess: StartCopilotLoginOptions['spawnProcess'] = vi.fn(() => loginProcess);
    const login = startCopilotLogin({
      loginId: 'login-1',
      onComplete,
      resolveRuntimePath: () => '/tmp/copilot',
      spawnProcess,
      timeoutMs: 1000
    });

    loginProcess.stdout.write('To authenticate, visit https://github.com/login/device and enter code 1234-ABCD.');

    await expect(login).resolves.toEqual({
      opened: true,
      loginId: 'login-1',
      verificationUri: 'https://github.com/login/device',
      deviceCode: '1234-ABCD'
    });
    expect(onComplete).not.toHaveBeenCalled();

    loginProcess.emit('close', 0, null);

    expect(onComplete).toHaveBeenCalledWith({ loginId: 'login-1', success: true });
  });
});

const createLoginProcess = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn()
  });
