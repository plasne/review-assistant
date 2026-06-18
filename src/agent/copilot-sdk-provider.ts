import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CopilotClient, RuntimeConnection, ToolSet } from '@github/copilot-sdk';
import type {
  AssistantReasoningDeltaEvent,
  AssistantReasoningEvent,
  AssistantTurnEndEvent,
  AssistantTurnStartEvent,
  AssistantUsageEvent,
  MCPServerConfig,
  ModelCallFailureEvent,
  PermissionHandler,
  SessionConfig,
  Tool,
  ToolExecutionCompleteEvent,
  ToolExecutionStartEvent,
  ToolResultObject
} from '@github/copilot-sdk';
import { configuredAgentSettingKeys } from '../shared/agent-settings';
import type { AgentErrorEnvelope, AgentSettings, AgentStatusSnapshot, ExternalMcpServerConfig, LocalToolMetadata, ToolInvocationResponse } from '../shared/types';
import { resolveCopilotRuntimePath } from '../main/copilot-runtime';
import type { ActiveProviderRun, AgentProvider, AgentProviderFactoryDeps, ChatContext, ProviderStartRequest } from './provider';

type ExternalMcpToolStart = {
  startedAt: number;
  server: string;
  tool: string;
  sdkToolName: string;
};

type ProviderTurnStart = {
  startedAt: number;
  reasoningDeltaChars: number;
  reasoningDeltaCount: number;
};

export const createCopilotSdkProvider = (deps: AgentProviderFactoryDeps): AgentProvider => ({
  getStatus: async (requestId) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-copilot-status-'));
    const client = createClient(tempDir);
    const startedAt = Date.now();
    try {
      logCopilotStatusStep(deps, requestId, 'client.start', 'begin', startedAt);
      await client.start();
      logCopilotStatusStep(deps, requestId, 'client.start', 'end', startedAt);
      logCopilotStatusStep(deps, requestId, 'client.ping', 'begin', startedAt);
      await client.ping('review-assistant-status');
      logCopilotStatusStep(deps, requestId, 'client.ping', 'end', startedAt);
      logCopilotStatusStep(deps, requestId, 'client.getAuthStatus', 'begin', startedAt);
      const authStatus = await client.getAuthStatus();
      logCopilotStatusStep(deps, requestId, 'client.getAuthStatus', 'end', startedAt, { isAuthenticated: authStatus.isAuthenticated });
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
  const externalMcpToolStarts = new Map<string, ExternalMcpToolStart>();
  const providerTurnStarts = new Map<string, ProviderTurnStart>();
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
    unsubscribers.push(
      session.on('tool.execution_start', (event) => {
        logExternalMcpToolStarted(request, event, externalMcpToolStarts);
      })
    );
    unsubscribers.push(
      session.on('tool.execution_complete', (event) => {
        logExternalMcpToolCompleted(request, event, externalMcpToolStarts);
      })
    );
    unsubscribers.push(
      session.on('assistant.turn_start', (event) => {
        logProviderTurnStarted(request, event, providerTurnStarts);
      })
    );
    unsubscribers.push(
      session.on('assistant.turn_end', (event) => {
        logProviderTurnCompleted(request, event, providerTurnStarts);
      })
    );
    unsubscribers.push(
      session.on('assistant.reasoning_delta', (event) => {
        accumulateReasoningDelta(event, providerTurnStarts);
      })
    );
    unsubscribers.push(
      session.on('assistant.reasoning', (event) => {
        logProviderReasoning(request, event);
      })
    );
    unsubscribers.push(
      session.on('assistant.message_start', (event) => {
        request.callbacks.log('info', 'review-assistant.agent-provider-message-started', {
          requestId: request.requestId,
          providerMessageId: event.data.messageId,
          phase: event.data.phase
        });
      })
    );
    unsubscribers.push(
      session.on('assistant.usage', (event) => {
        logProviderUsage(request, event);
      })
    );
    unsubscribers.push(
      session.on('model.call_failure', (event) => {
        logProviderModelCallFailed(request, event);
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

export const logExternalMcpToolStarted = (
  request: ProviderStartRequest,
  event: ToolExecutionStartEvent,
  starts: Map<string, ExternalMcpToolStart>
): void => {
  if (!event.data.mcpServerName) {
    return;
  }
  const tool = event.data.mcpToolName ?? event.data.toolName;
  starts.set(event.data.toolCallId, {
    startedAt: Date.now(),
    server: event.data.mcpServerName,
    tool,
    sdkToolName: event.data.toolName
  });
  request.callbacks.log('info', 'review-assistant.external-mcp-tool-call-started', {
    requestId: request.requestId,
    toolRequestId: event.data.toolCallId,
    server: event.data.mcpServerName,
    tool,
    sdkToolName: event.data.toolName,
    turnId: event.data.turnId
  });
};

export const logExternalMcpToolCompleted = (
  request: ProviderStartRequest,
  event: ToolExecutionCompleteEvent,
  starts: Map<string, ExternalMcpToolStart>
): void => {
  const started = starts.get(event.data.toolCallId);
  if (!started) {
    return;
  }
  starts.delete(event.data.toolCallId);
  const resultContent = event.data.result?.content;
  const resultDetailedContent = event.data.result?.detailedContent;
  request.callbacks.log(event.data.success ? 'info' : 'error', 'review-assistant.external-mcp-tool-call-completed', {
    requestId: request.requestId,
    toolRequestId: event.data.toolCallId,
    server: started.server,
    tool: started.tool,
    sdkToolName: started.sdkToolName,
    ok: event.data.success,
    code: event.data.success ? undefined : event.data.error?.code,
    resultChars: typeof resultContent === 'string' ? resultContent.length : undefined,
    detailedResultChars: typeof resultDetailedContent === 'string' ? resultDetailedContent.length : undefined,
    elapsedMs: Date.now() - started.startedAt,
    turnId: event.data.turnId
  });
};

export const logProviderTurnStarted = (
  request: ProviderStartRequest,
  event: AssistantTurnStartEvent,
  starts: Map<string, ProviderTurnStart>
): void => {
  starts.set(event.data.turnId, {
    startedAt: Date.now(),
    reasoningDeltaChars: 0,
    reasoningDeltaCount: 0
  });
  request.callbacks.log('info', 'review-assistant.agent-provider-turn-started', {
    requestId: request.requestId,
    turnId: event.data.turnId,
    interactionId: event.data.interactionId,
    agentId: event.agentId
  });
};

export const logProviderTurnCompleted = (
  request: ProviderStartRequest,
  event: AssistantTurnEndEvent,
  starts: Map<string, ProviderTurnStart>
): void => {
  const started = starts.get(event.data.turnId);
  if (started) {
    starts.delete(event.data.turnId);
  }
  request.callbacks.log('info', 'review-assistant.agent-provider-turn-completed', {
    requestId: request.requestId,
    turnId: event.data.turnId,
    agentId: event.agentId,
    elapsedMs: started ? Date.now() - started.startedAt : undefined,
    reasoningDeltaCount: started?.reasoningDeltaCount,
    reasoningDeltaChars: started?.reasoningDeltaChars
  });
};

export const accumulateReasoningDelta = (event: AssistantReasoningDeltaEvent, starts: Map<string, ProviderTurnStart>): void => {
  const turnId = reasoningTurnId(event.data.reasoningId);
  if (!turnId) {
    return;
  }
  const started = starts.get(turnId);
  if (!started) {
    return;
  }
  started.reasoningDeltaCount += 1;
  started.reasoningDeltaChars += event.data.deltaContent.length;
};

export const logProviderReasoning = (request: ProviderStartRequest, event: AssistantReasoningEvent): void => {
  request.callbacks.log('info', 'review-assistant.agent-provider-reasoning-completed', {
    requestId: request.requestId,
    reasoningId: event.data.reasoningId,
    agentId: event.agentId,
    reasoningChars: event.data.content.length
  });
};

export const logProviderUsage = (request: ProviderStartRequest, event: AssistantUsageEvent): void => {
  request.callbacks.log('info', 'review-assistant.agent-provider-usage', {
    requestId: request.requestId,
    agentId: event.agentId,
    apiCallId: event.data.apiCallId,
    apiEndpoint: event.data.apiEndpoint,
    providerCallId: event.data.providerCallId,
    serviceRequestId: event.data.serviceRequestId,
    model: event.data.model,
    reasoningEffort: event.data.reasoningEffort,
    initiator: event.data.initiator,
    inputTokens: event.data.inputTokens,
    outputTokens: event.data.outputTokens,
    reasoningTokens: event.data.reasoningTokens,
    cacheReadTokens: event.data.cacheReadTokens,
    cacheWriteTokens: event.data.cacheWriteTokens,
    cost: event.data.cost,
    timeToFirstTokenMs: event.data.timeToFirstTokenMs,
    interTokenLatencyMs: event.data.interTokenLatencyMs,
    elapsedMs: event.data.duration
  });
};

export const logProviderModelCallFailed = (request: ProviderStartRequest, event: ModelCallFailureEvent): void => {
  request.callbacks.log('error', 'review-assistant.agent-provider-model-call-failed', {
    requestId: request.requestId,
    agentId: event.agentId,
    apiCallId: event.data.apiCallId,
    providerCallId: event.data.providerCallId,
    serviceRequestId: event.data.serviceRequestId,
    model: event.data.model,
    initiator: event.data.initiator,
    source: event.data.source,
    statusCode: event.data.statusCode,
    elapsedMs: event.data.durationMs,
    errorMessageChars: event.data.errorMessage?.length
  });
};

export const logCopilotStatusStep = (
  deps: Pick<AgentProviderFactoryDeps, 'sendLog'>,
  requestId: string,
  step: 'client.start' | 'client.ping' | 'client.getAuthStatus',
  phase: 'begin' | 'end',
  startedAt: number,
  fields: Record<string, unknown> = {}
): void => {
  deps.sendLog('info', 'review-assistant.copilot-status-step', {
    requestId,
    step,
    phase,
    elapsedMs: Date.now() - startedAt,
    ...fields
  });
};

const reasoningTurnId = (reasoningId: string): string | undefined => {
  const match = /^turn-(.+?)-reasoning(?:-|$)/.exec(reasoningId);
  return match?.[1];
};

const createClient = (tempDir: string): CopilotClient => {
  const command = process.env.COPILOT_RUNTIME_COMMAND || resolveCopilotRuntimePath();
  const args = parseRuntimeArgs(process.env.COPILOT_RUNTIME_ARGS ?? '');
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
