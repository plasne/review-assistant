import { describe, expect, it } from 'vitest';
import { createPermissionHandler, toAvailableTools, toSdkMcpServers, toSdkToolResult } from '../../src/agent/copilot-sdk-provider';
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
});

const externalMcpServer = (): ExternalMcpServerConfig => ({
  id: 'source',
  command: 'source-mcp',
  args: ['stdio'],
  env: { SOURCE_TOKEN: 'secret-token' },
  timeout: 5000,
  allowedTools: ['search']
});
