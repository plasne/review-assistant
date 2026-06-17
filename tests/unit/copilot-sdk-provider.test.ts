import { describe, expect, it } from 'vitest';
import {
  accumulateReasoningDelta,
  createPermissionHandler,
  logExternalMcpToolCompleted,
  logExternalMcpToolStarted,
  logProviderModelCallFailed,
  logProviderReasoning,
  logProviderTurnCompleted,
  logProviderTurnStarted,
  logProviderUsage,
  toAvailableTools,
  toSdkMcpServers,
  toSdkSessionSettings,
  toSdkToolResult
} from '../../src/agent/copilot-sdk-provider';
import type { ProviderStartRequest } from '../../src/agent/provider';
import type { ExternalMcpServerConfig, LocalToolMetadata, ToolInvocationResponse } from '../../src/shared/types';

const tools: LocalToolMetadata[] = [
  {
    name: 'readRecord',
    description: 'Read selected record',
    source: 'built-in',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'listTools',
    description: 'List tools',
    source: 'built-in',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

describe('copilot SDK provider mapping', () => {
  it('builds an explicit SDK tool allowlist without ambient built-ins', () => {
    expect(toAvailableTools({ tools: [], mcpServers: [] })).toEqual([]);
    expect(toAvailableTools({ tools, mcpServers: [] })).toEqual(['custom:readRecord', 'custom:listTools']);
    expect(toAvailableTools({ tools: [], mcpServers: [externalMcpServer()] })).toEqual(['mcp:*']);
  });

  it('maps external MCP servers to SDK stdio server configs with server-local tool allowlists', () => {
    expect(toSdkMcpServers([externalMcpServer()])).toEqual({
      source: {
        type: 'stdio',
        command: 'source-mcp',
        args: ['stdio'],
        env: { SOURCE_TOKEN: 'secret-token' },
        timeout: 5000,
        tools: ['search']
      }
    });
  });

  it('maps supported agent settings to Copilot SDK session config', () => {
    expect(
      toSdkSessionSettings({
        model: 'gpt-5.5',
        reasoningEffort: 'high'
      })
    ).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'high'
    });
  });

  it('approves only registered custom tools and configured external MCP tools', async () => {
    const handler = createPermissionHandler(tools, [externalMcpServer()]);

    expect(
      await handler(
        {
          kind: 'custom-tool',
          toolName: 'readRecord',
          toolDescription: 'Read selected record'
        },
        { sessionId: 'session-1' }
      )
    ).toEqual({ kind: 'approve-once' });
    expect(
      await handler(
        {
          kind: 'custom-tool',
          toolName: 'unknown',
          toolDescription: 'Unknown'
        },
        { sessionId: 'session-1' }
      )
    ).toMatchObject({ kind: 'reject' });
    expect(
      await handler(
        {
          kind: 'mcp',
          serverName: 'source',
          toolName: 'search',
          toolTitle: 'Search',
          readOnly: true
        },
        { sessionId: 'session-1' }
      )
    ).toEqual({ kind: 'approve-once' });
    expect(
      await handler(
        {
          kind: 'mcp',
          serverName: 'source',
          toolName: 'write',
          toolTitle: 'Write',
          readOnly: false
        },
        { sessionId: 'session-1' }
      )
    ).toMatchObject({ kind: 'reject' });
  });

  it('converts local tool failures into SDK failure results instead of throwing', () => {
    const response: ToolInvocationResponse = {
      requestId: 'tool-1',
      ok: false,
      error: {
        code: 'TOOL_NOT_FOUND',
        message: 'Missing tool',
        retryable: false
      }
    };

    expect(toSdkToolResult(response)).toEqual({
      textResultForLlm: 'TOOL_NOT_FOUND: Missing tool',
      resultType: 'failure',
      error: 'TOOL_NOT_FOUND: Missing tool'
    });
  });

  it('logs external MCP tool execution from SDK session events without result payloads', () => {
    const logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const request: ProviderStartRequest = {
      requestId: 'chat-1',
      messageId: 'message-1',
      context: { message: 'search', tools: [] },
      prompt: 'search',
      startedAt: Date.now(),
      callbacks: {
        chunk: () => undefined,
        complete: () => undefined,
        error: () => undefined,
        log: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => {
          logs.push({ level, event, fields });
        }
      }
    };
    const starts = new Map();

    logExternalMcpToolStarted(
      request,
      {
        type: 'tool.execution_start',
        id: 'event-1',
        parentId: null,
        timestamp: '2026-06-05T16:00:00.000Z',
        data: {
          toolCallId: 'tool-call-1',
          toolName: 'mcp_github_search_code',
          mcpServerName: 'github',
          mcpToolName: 'search_code',
          arguments: { query: 'dial' },
          turnId: 'turn-1'
        }
      },
      starts
    );
    logExternalMcpToolCompleted(
      request,
      {
        type: 'tool.execution_complete',
        id: 'event-2',
        parentId: 'event-1',
        timestamp: '2026-06-05T16:00:01.000Z',
        data: {
          toolCallId: 'tool-call-1',
          success: true,
          result: { content: 'result payload that should not be logged', detailedContent: 'full result payload' },
          turnId: 'turn-1'
        }
      },
      starts
    );

    expect(logs).toEqual([
      {
        level: 'info',
        event: 'review-assistant.external-mcp-tool-call-started',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          toolRequestId: 'tool-call-1',
          server: 'github',
          tool: 'search_code',
          sdkToolName: 'mcp_github_search_code',
          turnId: 'turn-1'
        })
      },
      {
        level: 'info',
        event: 'review-assistant.external-mcp-tool-call-completed',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          toolRequestId: 'tool-call-1',
          server: 'github',
          tool: 'search_code',
          sdkToolName: 'mcp_github_search_code',
          ok: true,
          resultChars: 'result payload that should not be logged'.length,
          detailedResultChars: 'full result payload'.length,
          turnId: 'turn-1'
        })
      }
    ]);
    expect(logs[1]?.fields).not.toMatchObject({ result: expect.anything() });
  });

  it('logs provider turn and reasoning diagnostics without reasoning text', () => {
    const logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const request = providerRequest(logs);
    const starts = new Map();

    logProviderTurnStarted(
      request,
      {
        type: 'assistant.turn_start',
        id: 'event-1',
        parentId: null,
        timestamp: '2026-06-05T16:00:00.000Z',
        data: {
          turnId: '1',
          interactionId: 'interaction-1'
        }
      },
      starts
    );
    accumulateReasoningDelta(
      {
        type: 'assistant.reasoning_delta',
        id: 'event-2',
        parentId: 'event-1',
        timestamp: '2026-06-05T16:00:00.100Z',
        ephemeral: true,
        data: {
          reasoningId: 'turn-1-reasoning-1',
          deltaContent: 'private reasoning'
        }
      },
      starts
    );
    logProviderReasoning(request, {
      type: 'assistant.reasoning',
      id: 'event-3',
      parentId: 'event-2',
      timestamp: '2026-06-05T16:00:00.200Z',
      data: {
        reasoningId: 'turn-1-reasoning-1',
        content: 'complete private reasoning'
      }
    });
    logProviderTurnCompleted(
      request,
      {
        type: 'assistant.turn_end',
        id: 'event-4',
        parentId: 'event-3',
        timestamp: '2026-06-05T16:00:01.000Z',
        data: {
          turnId: '1'
        }
      },
      starts
    );

    expect(logs).toEqual([
      {
        level: 'info',
        event: 'review-assistant.agent-provider-turn-started',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          turnId: '1',
          interactionId: 'interaction-1'
        })
      },
      {
        level: 'info',
        event: 'review-assistant.agent-provider-reasoning-completed',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          reasoningId: 'turn-1-reasoning-1',
          reasoningChars: 'complete private reasoning'.length
        })
      },
      {
        level: 'info',
        event: 'review-assistant.agent-provider-turn-completed',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          turnId: '1',
          reasoningDeltaCount: 1,
          reasoningDeltaChars: 'private reasoning'.length
        })
      }
    ]);
    expect(logs[1]?.fields).not.toMatchObject({ content: expect.anything(), reasoningText: expect.anything() });
  });

  it('logs provider usage and model failures with metadata only', () => {
    const logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const request = providerRequest(logs);

    logProviderUsage(request, {
      type: 'assistant.usage',
      id: 'event-1',
      parentId: null,
      timestamp: '2026-06-05T16:00:00.000Z',
      ephemeral: true,
      data: {
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 10,
        cost: 1.5,
        timeToFirstTokenMs: 1500,
        duration: 59000,
        providerCallId: 'provider-call-1',
        serviceRequestId: 'service-request-1'
      }
    });
    logProviderModelCallFailed(request, {
      type: 'model.call_failure',
      id: 'event-2',
      parentId: 'event-1',
      timestamp: '2026-06-05T16:01:00.000Z',
      ephemeral: true,
      data: {
        source: 'top_level',
        model: 'gpt-5.5',
        statusCode: 429,
        durationMs: 1234,
        errorMessage: 'provider payload should not be logged'
      }
    });

    expect(logs).toEqual([
      {
        level: 'info',
        event: 'review-assistant.agent-provider-usage',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          cost: 1.5,
          timeToFirstTokenMs: 1500,
          elapsedMs: 59000
        })
      },
      {
        level: 'error',
        event: 'review-assistant.agent-provider-model-call-failed',
        fields: expect.objectContaining({
          requestId: 'chat-1',
          model: 'gpt-5.5',
          source: 'top_level',
          statusCode: 429,
          elapsedMs: 1234,
          errorMessageChars: 'provider payload should not be logged'.length
        })
      }
    ]);
    expect(logs[1]?.fields).not.toMatchObject({ errorMessage: expect.anything() });
  });
});

const externalMcpServer = (): ExternalMcpServerConfig => ({
  id: 'source',
  command: 'source-mcp',
  args: ['stdio'],
  env: { SOURCE_TOKEN: 'secret-token' },
  timeout: 5000,
  allowedTools: ['search']
});

const providerRequest = (logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }>): ProviderStartRequest => ({
  requestId: 'chat-1',
  messageId: 'message-1',
  context: { message: 'search', tools: [] },
  prompt: 'search',
  startedAt: Date.now(),
  callbacks: {
    chunk: () => undefined,
    complete: () => undefined,
    error: () => undefined,
    log: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => {
      logs.push({ level, event, fields });
    }
  }
});
