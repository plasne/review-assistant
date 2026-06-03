import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CopilotClient, RuntimeConnection, ToolSet } from '@github/copilot-sdk';
import type { MCPServerConfig, PermissionHandler, SessionConfig, Tool, ToolResultObject } from '@github/copilot-sdk';
import { configuredAgentSettingKeys } from '../shared/agent-settings';
import type { AgentErrorEnvelope, AgentSettings, AgentStatusSnapshot, ExternalMcpServerConfig, LocalToolMetadata, ToolInvocationResponse } from '../shared/types';
import { resolveCopilotRuntimePath } from '../main/copilot-runtime';
import type { ActiveProviderRun, AgentProvider, AgentProviderFactoryDeps, ChatContext, ProviderStartRequest } from './provider';

export const createCopilotSdkProvider = (deps: AgentProviderFactoryDeps): AgentProvider => ({
  getStatus: async (_requestId) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-copilot-status-'));
    const client = createClient(tempDir);
    try {
      await client.start();
      await client.ping('review-assistant-status');
      const authStatus = await client.getAuthStatus();
      if (!authStatus.isAuthenticated) {
        return unavailable(
          deps,
          deps.normalizeProviderError(new Error(authStatus.statusMessage || 'Authentication required. Please login to GitHub Copilot.'))
        );
      }
      return {
        provider: deps.providerMetadata,
        availability: 'ready',
        settings: deps.agentSettings
      };
    } catch (error) {
      return unavailable(deps, deps.normalizeProviderError(error));
    } finally {
      await stopClient(client, deps);
      await cleanupTempDir(tempDir);
    }
  },
  startChat: async (request) => await startSdkChat(deps, request)
});

const startSdkChat = async (deps: AgentProviderFactoryDeps, request: ProviderStartRequest): Promise<ActiveProviderRun> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-copilot-'));
  const client = createClient(tempDir);
  let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;
  const unsubscribers: Array<() => void> = [];
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
    if (session) {
      try {
        await session.disconnect();
      } catch (error) {
        request.callbacks.log('error', 'review-assistant.agent-provider-disconnect-failed', {
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    await stopClient(client, deps);
    await cleanupTempDir(tempDir);
  };

  try {
    await client.start();
    const agentSettings = request.context.agentSettings ?? deps.agentSettings;
    session = await client.createSession({
      clientName: 'review-assistant',
      ...toSdkSessionSettings(agentSettings),
      tools: createSdkTools(deps, request.requestId, request.context.tools),
      mcpServers: toSdkMcpServers(request.context.mcpServers ?? []),
      availableTools: toAvailableTools(request.context),
      onPermissionRequest: createPermissionHandler(request.context.tools, request.context.mcpServers ?? []),
      workingDirectory: tempDir,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      manageScheduleEnabled: false,
      requestExtensions: false,
      requestCanvasRenderer: false,
      enableMcpApps: false,
      infiniteSessions: { enabled: false },
      largeOutput: { enabled: false },
      mcpOAuthTokenStorage: 'in-memory'
    });
    unsubscribers.push(
      session.on('assistant.message_delta', (event) => {
        if (event.data.deltaContent) {
          request.callbacks.chunk(event.data.deltaContent);
        }
      })
    );
    unsubscribers.push(
      session.on('session.error', (event) => {
        request.callbacks.error(deps.normalizeProviderError(new Error(event.data.message)));
      })
    );
    unsubscribers.push(
      session.on('session.idle', () => {
        request.callbacks.complete();
      })
    );
    request.callbacks.log('info', 'review-assistant.agent-provider-spawned', {
      requestId: request.requestId,
      pid: 'sdk',
      command: '@github/copilot-sdk',
      argCount: 0,
      agentSettings: configuredAgentSettingKeys(agentSettings).join(',') || 'none',
      elapsedMs: Date.now() - request.startedAt
    });
    await session.send({ prompt: request.prompt, mode: 'immediate' });
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    cancel: async () => {
      try {
        await session?.abort();
      } catch (error) {
        request.callbacks.log('error', 'review-assistant.agent-provider-cancel-failed', {
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },
    dispose
  };
};

export const toAvailableTools = (context: Pick<ChatContext, 'tools' | 'mcpServers'>): string[] => {
  const toolSet = new ToolSet();
  for (const tool of context.tools) {
    toolSet.addCustom(tool.name);
  }
  if ((context.mcpServers ?? []).length > 0) {
    toolSet.addMcp('*');
  }
  return toolSet.toArray();
};

export const toSdkSessionSettings = (settings: AgentSettings): Pick<SessionConfig, 'model' | 'reasoningEffort'> => ({
  ...(settings.model === undefined ? {} : { model: settings.model }),
  ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort })
});

export const toSdkMcpServers = (servers: ExternalMcpServerConfig[]): Record<string, MCPServerConfig> =>
  Object.fromEntries(
    servers.map((server) => [
      server.id,
      {
        type: 'stdio',
        command: server.command,
        args: server.args,
        ...(server.env === undefined ? {} : { env: server.env }),
        ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
        tools: server.allowedTools ?? ['*']
      }
    ])
  );

export const createPermissionHandler =
  (localTools: LocalToolMetadata[], externalServers: ExternalMcpServerConfig[]): PermissionHandler =>
  (request) => {
    if (request.kind === 'custom-tool') {
      return localTools.some((tool) => tool.name === request.toolName)
        ? { kind: 'approve-once' }
        : { kind: 'reject', feedback: `Review Assistant did not register custom tool: ${request.toolName}` };
    }
    if (request.kind === 'mcp') {
      const server = externalServers.find((candidate) => candidate.id === request.serverName);
      const allowedTools = server?.allowedTools;
      const allowed = Boolean(server) && (allowedTools === undefined || allowedTools.includes('*') || allowedTools.includes(request.toolName));
      return allowed
        ? { kind: 'approve-once' }
        : { kind: 'reject', feedback: `Review Assistant did not allow MCP tool: ${request.serverName}(${request.toolName})` };
    }
    return { kind: 'reject', feedback: `Review Assistant does not grant ${request.kind} permissions.` };
  };

export const toSdkToolResult = (response: ToolInvocationResponse): unknown => {
  if (response.ok) {
    return response.result;
  }
  const message = `${response.error.code}: ${response.error.message}`;
  return {
    textResultForLlm: message,
    resultType: 'failure',
    error: message
  } satisfies ToolResultObject;
};

const createSdkTools = (deps: AgentProviderFactoryDeps, chatRequestId: string, tools: LocalToolMetadata[]): Tool[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    skipPermission: true,
    handler: async (args: unknown) => {
      const response = await deps.requestTool(chatRequestId, {
        tool: tool.name,
        requestId: randomUUID(),
        arguments: isRecord(args) ? args : {}
      });
      return toSdkToolResult(response);
    }
  }));

const createClient = (tempDir: string): CopilotClient => {
  const command = process.env.REVIEW_ASSISTANT_COPILOT_RUNTIME_COMMAND || process.env.REVIEW_ASSISTANT_COPILOT_COMMAND || resolveCopilotRuntimePath();
  const args = parseRuntimeArgs(process.env.REVIEW_ASSISTANT_COPILOT_RUNTIME_ARGS ?? process.env.REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS ?? '');
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: command, args }),
    mode: 'empty',
    workingDirectory: tempDir,
    baseDirectory: tempDir,
    logLevel: 'error',
    env: {
      ...process.env,
      NO_COLOR: '1'
    }
  });
};

const parseRuntimeArgs = (value: string): string[] => value.split('\n').filter(Boolean);

const stopClient = async (client: CopilotClient, deps: AgentProviderFactoryDeps): Promise<void> => {
  const errors = await client.stop();
  for (const error of errors) {
    deps.sendLog('error', 'review-assistant.agent-provider-stop-failed', { message: error.message });
  }
};

const cleanupTempDir = async (tempDir: string): Promise<void> => {
  await fs.rm(tempDir, { recursive: true, force: true });
};

const unavailable = (deps: AgentProviderFactoryDeps, error: AgentErrorEnvelope): AgentStatusSnapshot => ({
  provider: deps.providerMetadata,
  availability: 'unavailable',
  error,
  settings: deps.agentSettings
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
