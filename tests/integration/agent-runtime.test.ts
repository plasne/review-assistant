// @vitest-environment node

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/main/agent';
import type { ChatStreamChunk } from '../../src/shared/types';
import type { LocalToolRuntime } from '../../src/main/tools';

let tempRoot: string;
let workerPath: string;
const fakeProviderModule = path.resolve('test-fixtures/fake-copilot-sdk-provider.mjs');

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-agent-test-'));
  workerPath = path.join(tempRoot, 'agent-process.cjs');
  await build({
    entryPoints: ['src/agent/agent-process.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['@github/copilot-sdk', '@github/copilot']
  });
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('agent runtime streaming pipeline', () => {
  it('streams chunks from the isolated worker after reading record details through a local tool', async () => {
    const chunks: ChatStreamChunk[] = [];
    const toolRequests: string[] = [];
    const tools = createFakeToolRuntime(toolRequests);
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS: '1' }
    });

    await expect(runtime.getStatus()).resolves.toMatchObject({ availability: 'ready' });
    const complete = new Promise<string>((resolve, reject) => {
      runtime
        .start(
          {
            projectId: 'sample-project',
            recordId: 'valid-record',
            projectPrompt: 'Answer briefly.',
            message: 'summarize this record',
            tools: tools.listTools()
          },
          {
            chunk: (chunk) => chunks.push(chunk),
            complete: () => resolve(chunks.map((chunk) => chunk.content).join('')),
            error: (event) => reject(new Error(event.error.message)),
            canceled: () => reject(new Error('unexpected cancel'))
          },
          tools
        )
        .catch(reject);
    });

    await expect(complete).resolves.toBe('Record question: How do I run the harness?');
    expect(toolRequests).toEqual(['readRecord']);
  });

  it('propagates cancellation and releases the pending request', async () => {
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_REQUIRE_AVAILABLE_TOOLS_NONE: '1' }
    });
    const canceled = new Promise<boolean>((resolve, reject) => {
      runtime
        .start(
          { projectId: 'sample-project', message: 'slow-cancel', tools: [] },
          {
            chunk: () => undefined,
            complete: () => reject(new Error('unexpected complete')),
            error: (event) => reject(new Error(event.error.message)),
            canceled: () => resolve(true)
          },
          createFakeToolRuntime()
        )
        .then((started) => {
          expect(runtime.cancel(started.requestId)).toBe(true);
        })
        .catch(reject);
    });

    await expect(canceled).resolves.toBe(true);
  });

  it('streams without project context when no project is selected', async () => {
    const chunks: ChatStreamChunk[] = [];
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_REQUIRE_AVAILABLE_TOOLS_NONE: '1' }
    });
    const complete = new Promise<string>((resolve, reject) => {
      runtime
        .start(
          { message: 'answer a general question', tools: [] },
          {
            chunk: (chunk) => chunks.push(chunk),
            complete: () => resolve(chunks.map((chunk) => chunk.content).join('')),
            error: (event) => reject(new Error(event.error.message)),
            canceled: () => reject(new Error('unexpected cancel'))
          },
          createFakeToolRuntime()
        )
        .catch(reject);
    });

    await expect(complete).resolves.toBe('Streamed Copilot response');
  });

  it('passes configured external MCP servers to Copilot with allowlisted tools', async () => {
    const chunks: ChatStreamChunk[] = [];
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_REQUIRE_EXTERNAL_MCP: '1' }
    });
    const complete = new Promise<string>((resolve, reject) => {
      runtime
        .start(
          {
            projectId: 'sample-project',
            message: 'search external sources for review harness examples',
            tools: [],
            mcpServers: [
              {
                id: 'source',
                command: 'source-mcp',
                args: ['stdio'],
                env: { SOURCE_TOKEN: 'secret-token' },
                allowedTools: ['search']
              }
            ]
          },
          {
            chunk: (chunk) => chunks.push(chunk),
            complete: () => resolve(chunks.map((chunk) => chunk.content).join('')),
            error: (event) => reject(new Error(event.error.message)),
            canceled: () => reject(new Error('unexpected cancel'))
          },
          createFakeToolRuntime()
        )
        .catch(reject);
    });

    await expect(complete).resolves.toBe('Streamed Copilot response');
  });

  it('passes app-level external MCP servers without project context', async () => {
    const chunks: ChatStreamChunk[] = [];
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_REQUIRE_EXTERNAL_MCP: '1' }
    });
    const complete = new Promise<string>((resolve, reject) => {
      runtime
        .start(
          {
            message: 'search shared external sources',
            tools: [],
            mcpServers: [
              {
                id: 'source',
                command: 'source-mcp',
                args: ['stdio'],
                env: { SOURCE_TOKEN: 'secret-token' },
                allowedTools: ['search']
              }
            ]
          },
          {
            chunk: (chunk) => chunks.push(chunk),
            complete: () => resolve(chunks.map((chunk) => chunk.content).join('')),
            error: (event) => reject(new Error(event.error.message)),
            canceled: () => reject(new Error('unexpected cancel'))
          },
          createFakeToolRuntime()
        )
        .catch(reject);
    });

    await expect(complete).resolves.toBe('Streamed Copilot response');
  });

  it('gates unavailable backends before chat starts', async () => {
    const runtime = new AgentRuntime({
      workerPath,
      command: path.join(tempRoot, 'missing-copilot')
    });

    await expect(runtime.getStatus()).resolves.toMatchObject({
      availability: 'unavailable',
      error: { code: 'BINARY_NOT_FOUND' }
    });
    await expect(
      runtime.start(
        { projectId: 'sample-project', message: 'hello', tools: [] },
        {
          chunk: () => undefined,
          complete: () => undefined,
          error: () => undefined,
          canceled: () => undefined
        },
        createFakeToolRuntime()
      )
    ).rejects.toThrow('GitHub Copilot runtime was not found.');
  });

  it('maps SDK authentication failures to the existing auth-required status contract', async () => {
    const runtime = new AgentRuntime({
      workerPath,
      providerModule: fakeProviderModule,
      commandEnv: { FAKE_COPILOT_FAIL: 'auth' }
    });

    await expect(runtime.getStatus()).resolves.toMatchObject({
      availability: 'unavailable',
      error: { code: 'AUTH_REQUIRED' }
    });
  });
});

const createFakeToolRuntime = (toolRequests: string[] = []): LocalToolRuntime => ({
  listTools: () => [
    {
      name: 'readRecord',
      description: 'Read selected record',
      source: 'built-in',
      inputSchema: { type: 'object', properties: { includeSchema: { type: 'boolean' } }, additionalProperties: false }
    },
    {
      name: 'listTools',
      description: 'List tools',
      source: 'built-in',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ],
  execute: async (request) => {
    toolRequests.push(request.tool);
    if (request.tool === 'readRecord') {
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: 'sample-project',
          recordId: 'valid-record',
          contentType: 'application/json',
          record: { question: 'How do I run the harness?' }
        }
      };
    }
    return {
      requestId: request.requestId,
      ok: true,
      result: { tools: [] }
    };
  }
});
