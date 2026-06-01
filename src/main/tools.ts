import { randomUUID } from 'node:crypto';
import type { AgentErrorEnvelope, LocalToolMetadata, ToolInvocationRequest, ToolInvocationResponse } from '../shared/types';
import type { StorageAdapter } from './storage';

type ToolExecutionContext = {
  storage?: StorageAdapter;
  selectedProjectId?: string;
  selectedRecordId?: string;
};

export type LocalToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    request: ToolInvocationRequest,
    context: ToolExecutionContext,
    listTools: () => LocalToolMetadata[]
  ) => Promise<ToolInvocationResponse>;
};

export type LocalToolPlugin = {
  id: string;
  tools: LocalToolDefinition[];
};

export type LocalToolRuntime = {
  listTools: () => LocalToolMetadata[];
  execute: (request: ToolInvocationRequest) => Promise<ToolInvocationResponse>;
};

type RegisteredTool = LocalToolDefinition & {
  source: 'built-in' | 'plugin';
  pluginId?: string;
};

const readRecordTool: LocalToolDefinition = {
  name: 'readRecord',
  description: 'Read the record currently selected in the Review Assistant UI. Project and record identifiers always come from trusted UI state.',
  inputSchema: {
    type: 'object',
    properties: {
      includeSchema: {
        type: 'boolean',
        description: 'Whether to include the record schema in the response.'
      }
    },
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId || !context.selectedRecordId) {
      return toolError(request.requestId, 'NO_RECORD_SELECTED', 'No record is currently displayed in the UI.', false);
    }
    if (typeof request.arguments.includeSchema !== 'boolean' && request.arguments.includeSchema !== undefined) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'includeSchema must be a boolean when provided.', false);
    }

    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: record.projectId,
          recordId: record.recordId,
          contentType: 'application/json',
          record: record.data,
          ...(request.arguments.includeSchema === true ? { schema: record.schema } : {})
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.toLowerCase().includes('record not found') ? 'RECORD_NOT_FOUND' : 'PROVIDER_ERROR';
      return toolError(request.requestId, code, message, false);
    }
  }
};

const listToolsTool: LocalToolDefinition = {
  name: 'listTools',
  description: 'List Review Assistant local tools.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  execute: async (request, _context, listTools) => ({
    requestId: request.requestId,
    ok: true,
    result: { tools: listTools() }
  })
};

const builtInTools = [readRecordTool, listToolsTool];

export const createLocalToolRuntime = (context: ToolExecutionContext, plugins: LocalToolPlugin[] = []): LocalToolRuntime => {
  const registeredTools = registerTools(plugins);
  const listTools = (): LocalToolMetadata[] =>
    registeredTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      source: tool.source,
      pluginId: tool.pluginId,
      inputSchema: tool.inputSchema
    }));

  return {
    listTools,
    execute: async (request) => {
      const tool = registeredTools.find((candidate) => candidate.name === request.tool);
      if (!tool) {
        return toolError(request.requestId, 'TOOL_NOT_FOUND', `Tool not found: ${request.tool}`, false);
      }
      return tool.execute(request, context, listTools);
    }
  };
};

export const createToolRequest = (tool: string, args: Record<string, unknown>): ToolInvocationRequest => ({
  tool,
  requestId: randomUUID(),
  arguments: args
});

const registerTools = (plugins: LocalToolPlugin[]): RegisteredTool[] => {
  const registeredTools: RegisteredTool[] = [
    ...builtInTools.map((tool): RegisteredTool => ({ ...tool, source: 'built-in' }))
  ];
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      if (registeredTools.some((registered) => registered.name === tool.name)) {
        throw new Error(`Duplicate local tool name: ${tool.name}`);
      }
      registeredTools.push({ ...tool, source: 'plugin', pluginId: plugin.id });
    }
  }
  return registeredTools;
};

const toolError = (
  requestId: string,
  code: AgentErrorEnvelope['code'],
  message: string,
  retryable: boolean
): ToolInvocationResponse => ({
  requestId,
  ok: false,
  error: { code, message, retryable }
});
