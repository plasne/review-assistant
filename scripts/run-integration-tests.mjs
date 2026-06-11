import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';

const repoRoot = path.resolve(import.meta.dirname, '..');
const azuriteBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'azurite.cmd' : 'azurite');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'review-assistant-azurite-'));

const azurite = spawn(azuriteBin, ['--silent', '--skipApiVersionCheck', '--location', workspace], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe']
});

let azuriteOutput = '';
azurite.stdout.on('data', (chunk) => {
  azuriteOutput += chunk.toString();
});
azurite.stderr.on('data', (chunk) => {
  azuriteOutput += chunk.toString();
});

try {
  await waitForPort(10000, '127.0.0.1', 15_000);
  await waitForPort(10001, '127.0.0.1', 15_000);
  const result = await runCommand('npx', ['vitest', 'run', '--config', 'vitest.config.ts', 'tests/integration'], repoRoot);
  process.exitCode = result;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (azuriteOutput.trim()) {
    process.stderr.write(`\nAzurite output:\n${azuriteOutput}\n`);
  }
  process.exitCode = 1;
} finally {
  azurite.kill();
  await waitForExit(azurite);
  await rm(workspace, { recursive: true, force: true });
}

async function waitForPort(port, host, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (azurite.exitCode !== null) {
      throw new Error(`Azurite exited before becoming ready with code ${azurite.exitCode}.`);
    }
    if (await canConnect(port, host)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Azurite at ${host}:${port}.`);
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
