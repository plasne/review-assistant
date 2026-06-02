import { randomUUID } from 'node:crypto';
import type { AgentErrorEnvelope, LocalToolMetadata, ToolInvocationRequest, ToolInvocationResponse } from '../shared/types';
import { stripFeedbackProperties } from '../shared/feedback';
import { validateRecord } from './schema';
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

type JsonSchema = Record<string, unknown>;
type ContainerCandidate = {
  path: string;
  description?: string;
  itemCount: number | undefined;
  containerSchema: JsonSchema;
  itemSchema?: unknown;
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
          record: stripFeedbackProperties(record.data),
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

const getRecordContainerSchemaTool: LocalToolDefinition = {
  name: 'getRecordContainerSchema',
  description:
    'List or inspect array containers in the currently selected record schema before saving search results. The optional containerPath is a JSON Pointer such as /evidence or /turns/0/references.',
  inputSchema: {
    type: 'object',
    properties: {
      containerPath: {
        type: 'string',
        description: 'Optional JSON Pointer to an array container in the selected record, for example /evidence or /turns/0/references.'
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
    const containerPath = request.arguments.containerPath;
    if (containerPath !== undefined && typeof containerPath !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'containerPath must be a JSON Pointer string when provided.', false);
    }

    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      if (containerPath === undefined || containerPath.trim() === '') {
        return {
          requestId: request.requestId,
          ok: true,
          result: {
            projectId: record.projectId,
            recordId: record.recordId,
            containers: listContainerCandidates(record.schema, record.data)
          }
        };
      }
      const path = assertJsonPointer(containerPath);
      const containerSchema = schemaAtPointer(record.schema, path);
      if (!isArraySchema(containerSchema)) {
        return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', `Schema at ${path || '/'} is not an array container.`, false);
      }
      const currentValue = valueAtPointer(record.data, path);
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: record.projectId,
          recordId: record.recordId,
          container: {
            path,
            description: typeof containerSchema.description === 'string' ? containerSchema.description : undefined,
            itemCount: Array.isArray(currentValue) ? currentValue.length : undefined,
            containerSchema,
            itemSchema: containerSchema.items,
            currentValue
          }
        }
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
    }
  }
};

const saveSearchResultsTool: LocalToolDefinition = {
  name: 'saveSearchResults',
  description:
    'Append or replace MCP search result entries in an array container of the currently selected record, validate the full record against the project schema, and save it.',
  inputSchema: {
    type: 'object',
    properties: {
      containerPath: {
        type: 'string',
        description: 'JSON Pointer to the target array container in the selected record, for example /evidence or /turns/0/references.'
      },
      results: {
        type: 'array',
        description:
          'Search result entries to store. Each entry must match the target container item schema. URL-like fields should contain canonical user-facing locators returned by the source MCP tool, not synthesized provider URLs or API response endpoints.',
        items: {}
      },
      mode: {
        type: 'string',
        enum: ['append', 'replace'],
        description: 'Whether to append to the existing container or replace it entirely.'
      }
    },
    required: ['containerPath', 'results'],
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId || !context.selectedRecordId) {
      return toolError(request.requestId, 'NO_RECORD_SELECTED', 'No record is currently displayed in the UI.', false);
    }
    const containerPath = request.arguments.containerPath;
    const results = request.arguments.results;
    const mode = request.arguments.mode ?? 'append';
    if (typeof containerPath !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'containerPath must be a JSON Pointer string.', false);
    }
    if (!Array.isArray(results)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'results must be an array.', false);
    }
    if (mode !== 'append' && mode !== 'replace') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'mode must be append or replace when provided.', false);
    }

    try {
      const path = assertJsonPointer(containerPath);
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      const containerSchema = schemaAtPointer(record.schema, path);
      if (!isArraySchema(containerSchema)) {
        return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', `Schema at ${path || '/'} is not an array container.`, false);
      }
      const currentValue = valueAtPointer(record.data, path);
      if (currentValue !== undefined && !Array.isArray(currentValue)) {
        return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', `Record value at ${path || '/'} is not an array container.`, false);
      }
      const nextContainer = mode === 'append' ? [...(Array.isArray(currentValue) ? currentValue : []), ...results] : [...results];
      const nextData = path === '' ? nextContainer : cloneJson(record.data);
      if (path !== '') {
        setValueAtPointer(nextData, path, nextContainer);
      }
      const validationIssues = validateRecord(record.schema, nextData);
      if (validationIssues.length > 0) {
        return toolError(
          request.requestId,
          'INVALID_TOOL_ARGUMENTS',
          `Search results do not match the record schema: ${validationIssues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
          false
        );
      }
      const updatedRecord = await context.storage.updateRecord(context.selectedProjectId, context.selectedRecordId, nextData);
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: updatedRecord.projectId,
          recordId: updatedRecord.recordId,
          containerPath: path,
          mode,
          savedItemCount: results.length,
          containerItemCount: nextContainer.length,
          record: updatedRecord.data
        }
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
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

const builtInTools = [readRecordTool, getRecordContainerSchemaTool, saveSearchResultsTool, listToolsTool];

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

const listContainerCandidates = (schema: unknown, data: unknown): ContainerCandidate[] => {
  if (!isSchema(schema)) {
    return [];
  }
  return collectContainers(resolveSchema(schema), data, '');
};

const collectContainers = (schema: JsonSchema, data: unknown, path: string): ContainerCandidate[] => {
  const resolved = resolveSchema(schema);
  const type = schemaType(resolved, data);
  const current: ContainerCandidate[] =
    type === 'array'
      ? [
          {
            path,
            description: typeof resolved.description === 'string' ? resolved.description : undefined,
            itemCount: Array.isArray(data) ? data.length : undefined,
            containerSchema: resolved,
            itemSchema: resolved.items
          }
        ]
      : [];
  if (type === 'object') {
    const properties = isSchemaMap(resolved.properties) ? resolved.properties : {};
    const value = isPlainRecord(data) ? data : {};
    return [
      ...current,
      ...Object.entries(properties).flatMap(([key, childSchema]) =>
        collectContainers(childSchema, value[key], `${path}/${escapePointer(key)}`)
      )
    ];
  }
  if (type === 'array' && isSchema(resolved.items) && Array.isArray(data)) {
    return [
      ...current,
      ...data.flatMap((item, index) => collectContainers(resolved.items as JsonSchema, item, `${path}/${index}`))
    ];
  }
  return current;
};

const schemaAtPointer = (schema: unknown, path: string): JsonSchema => {
  if (!isSchema(schema)) {
    throw new Error('Project _schema.json must be a JSON object.');
  }
  return pointerSegments(path).reduce<JsonSchema>((current, segment) => {
    const resolved = resolveSchema(current);
    const type = schemaType(resolved, undefined);
    if (type === 'array') {
      if (!isSchema(resolved.items)) {
        throw new Error(`Schema at ${path || '/'} does not define object item schemas.`);
      }
      return resolved.items;
    }
    if (type === 'object') {
      const properties = isSchemaMap(resolved.properties) ? resolved.properties : {};
      const propertySchema = properties[segment];
      if (propertySchema) {
        return propertySchema;
      }
      if (isSchema(resolved.additionalProperties)) {
        return resolved.additionalProperties;
      }
    }
    throw new Error(`No schema exists at ${path || '/'}.`);
  }, schema);
};

const valueAtPointer = (data: unknown, path: string): unknown =>
  pointerSegments(path).reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0 ? current[index] : undefined;
    }
    if (isPlainRecord(current)) {
      return current[segment];
    }
    return undefined;
  }, data);

const setValueAtPointer = (data: unknown, path: string, value: unknown): void => {
  if (path === '') {
    throw new Error('Search results cannot replace the record root.');
  }
  const segments = pointerSegments(path);
  const last = segments.at(-1);
  let current = data;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || current[index] === undefined) {
        throw new Error(`Record path ${path || '/'} does not exist.`);
      }
      current = current[index];
    } else if (isPlainRecord(current)) {
      if (!(segment in current)) {
        current[segment] = {};
      }
      current = current[segment];
    } else {
      throw new Error(`Record path ${path || '/'} does not exist.`);
    }
  }
  if (last === undefined) {
    throw new Error('Search results cannot replace the record root.');
  }
  if (Array.isArray(current)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Record path ${path || '/'} does not exist.`);
    }
    current[index] = value;
    return;
  }
  if (isPlainRecord(current)) {
    current[last] = value;
    return;
  }
  throw new Error(`Record path ${path || '/'} does not exist.`);
};

const assertJsonPointer = (value: string): string => {
  if (value === '') {
    return value;
  }
  if (!value.startsWith('/')) {
    throw new Error('containerPath must be a JSON Pointer beginning with /.');
  }
  pointerSegments(value);
  return value;
};

const pointerSegments = (path: string): string[] => {
  if (path === '') {
    return [];
  }
  if (!path.startsWith('/')) {
    throw new Error('JSON Pointer must begin with /.');
  }
  return path
    .slice(1)
    .split('/')
    .map((segment) => {
      if (/~(?![01])/.test(segment)) {
        throw new Error('JSON Pointer contains an invalid escape sequence.');
      }
      return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
};

const escapePointer = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

const resolveSchema = (schema: JsonSchema): JsonSchema => {
  if (!Array.isArray(schema.allOf)) {
    return schema;
  }
  return schema.allOf.filter(isSchema).reduce<JsonSchema>((merged, current) => mergeSchemas(merged, current), { ...schema, allOf: undefined });
};

const mergeSchemas = (left: JsonSchema, right: JsonSchema): JsonSchema => {
  const merged: JsonSchema = { ...left, ...right };
  if (isSchemaMap(left.properties) || isSchemaMap(right.properties)) {
    merged.properties = { ...(isSchemaMap(left.properties) ? left.properties : {}), ...(isSchemaMap(right.properties) ? right.properties : {}) };
  }
  return merged;
};

const isArraySchema = (schema: JsonSchema): boolean => schemaType(resolveSchema(schema), undefined) === 'array';

const schemaType = (schema: JsonSchema, data: unknown): string | undefined => {
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  if (Array.isArray(schema.type) && typeof schema.type[0] === 'string') {
    return schema.type[0];
  }
  if (isSchemaMap(schema.properties) || isPlainRecord(data)) {
    return 'object';
  }
  if (Array.isArray(data)) {
    return 'array';
  }
  return undefined;
};

const isSchema = (value: unknown): value is JsonSchema => isPlainRecord(value);

const isSchemaMap = (value: unknown): value is Record<string, JsonSchema> =>
  isPlainRecord(value) && Object.values(value).every(isSchema);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const toolErrorCode = (error: unknown): AgentErrorEnvelope['code'] => {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('record not found')) {
    return 'RECORD_NOT_FOUND';
  }
  if (
    message.includes('json pointer') ||
    message.includes('containerpath') ||
    message.includes('no schema exists') ||
    message.includes('schema at') ||
    message.includes('record path')
  ) {
    return 'INVALID_TOOL_ARGUMENTS';
  }
  return 'PROVIDER_ERROR';
};
