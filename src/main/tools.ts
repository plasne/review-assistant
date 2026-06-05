import { randomUUID } from 'node:crypto';
import type { AgentErrorEnvelope, CanonicalMapping, FeedbackConfig, LocalToolMetadata, ToolInvocationRequest, ToolInvocationResponse } from '../shared/types';
import { CANONICAL_MAPPINGS, stripFeedbackProperties } from '../shared/feedback';
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
type TurnTargetMode = 'append-array' | 'merge-object';
type TurnTargetCandidate = {
  path: string;
  mode: TurnTargetMode;
  schema: JsonSchema;
  containerSchema?: JsonSchema;
  data: unknown;
  score: number;
  inquiryField?: string;
  responseField?: string;
  roleField?: string;
  messageField?: string;
};
type MessageHistoryFields = {
  roleField: string;
  messageField: string;
};
type ExistingTurnTarget =
  | {
  path: string;
  schema: JsonSchema;
  data: Record<string, unknown>;
    }
  | {
      path: string;
      schema: JsonSchema;
      data: undefined;
      appendMessageFields: MessageHistoryFields;
      insertAfterIndex?: number;
    };
type TurnFieldMapping = {
  inquiryField?: string;
  responseField?: string;
  evidenceField?: string;
};
type ResolvedTurnFields = {
  inquiryField: string;
  responseField: string;
  evidenceField?: string;
  roleField?: string;
  messageField?: string;
};

const readRecordTool: LocalToolDefinition = {
  name: 'readRecord',
  description:
    'Read the currently selected Review Assistant record, optionally including its JSON Schema. Use this before answering questions about selected-record content; project and record identity always come from trusted UI state.',
  inputSchema: {
    type: 'object',
    properties: {
      includeSchema: {
        type: 'boolean',
        description: 'Set true when you need field names, required fields, or valid shapes before deciding where or how to write record data.'
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

type CanonicalCandidate = {
  path: string;
  schema: JsonSchema;
};
type SchemaNodeCandidate = CanonicalCandidate & {
  type: string | undefined;
};

const discoverCanonicalSchemaMappingsTool: LocalToolDefinition = {
  name: 'discoverCanonicalSchemaMappings',
  description:
    'Find schema paths for Review Assistant canonical concepts: turns, request, response, evidence, facts, and tags. Use this before saving search results or configuring displays; explicit project config/config.json mappings are returned first and implicit schema candidates follow.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId || !context.selectedRecordId) {
      return toolError(request.requestId, 'NO_RECORD_SELECTED', 'No record is currently displayed in the UI.', false);
    }
    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      const config = await context.storage.getFeedbackConfig(context.selectedProjectId);
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: record.projectId,
          recordId: record.recordId,
          ...discoverCanonicalSchemaMappings(record.schema, config)
        }
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
    }
  }
};

const getRecordSchemaTool: LocalToolDefinition = {
  name: 'getRecordSchema',
  description:
    'Inspect the selected record JSON Schema, optionally at a JSON Pointer. Use this before startTurn/completeTurn when the destination path, field names, or turn shape are not already known.',
  inputSchema: {
    type: 'object',
    properties: {
      targetPath: {
        type: 'string',
        description: 'Optional JSON Pointer to inspect within the selected record schema. Use an empty string or omit it to inspect the schema root.'
      },
      includeTurnCandidates: {
        type: 'boolean',
        description:
          'Whether to include ranked destinations where startTurn/completeTurn can store conversation turns, including object turns and role/message history arrays.'
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
    const targetPath = request.arguments.targetPath;
    const includeTurnCandidates = request.arguments.includeTurnCandidates ?? true;
    if (targetPath !== undefined && typeof targetPath !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'targetPath must be a JSON Pointer string when provided.', false);
    }
    if (typeof includeTurnCandidates !== 'boolean') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'includeTurnCandidates must be a boolean when provided.', false);
    }

    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      const path = typeof targetPath === 'string' ? assertSchemaPointer(targetPath) : '';
      const schema = path === '' ? record.schema : schemaAtPointer(record.schema, path);
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: record.projectId,
          recordId: record.recordId,
          targetPath: path,
          schema,
          ...(includeTurnCandidates
            ? {
                turnCandidates: listTurnTargetCandidates(record.schema, record.data)
                  .sort((left, right) => right.score - left.score)
                  .map(toTurnCandidateResult)
              }
            : {})
        }
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
    }
  }
};

const saveGeneratedSchemaTool: LocalToolDefinition = {
  name: 'saveGeneratedSchema',
  description:
    'Replace the selected project config/schema.json with a generated JSON Schema after validating it. Existing schemas are backed up as config/schema_1.json, config/schema_2.json, etc.; project identity always comes from trusted UI state.',
  inputSchema: {
    type: 'object',
    properties: {
      schema: {
        type: 'object',
        description: 'The complete JSON Schema object to save as the selected project config/schema.json.'
      }
    },
    required: ['schema'],
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId) {
      return toolError(request.requestId, 'NO_PROJECT_SELECTED', 'No project is currently selected in the UI.', false);
    }
    const schema = request.arguments.schema;
    if (!isPlainRecord(schema)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'schema must be a JSON Schema object.', false);
    }
    try {
      validateRecord(schema, {});
    } catch (error) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', `schema must be a valid JSON Schema: ${errorMessage(error)}`, false);
    }

    try {
      const result = await context.storage.saveProjectSchema(context.selectedProjectId, schema);
      return {
        requestId: request.requestId,
        ok: true,
        result
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
    }
  }
};

const saveSearchResultsTool: LocalToolDefinition = {
  name: 'saveSearchResults',
  description:
    'Persist external MCP search results into an array field of the selected record draft. Use this for standalone evidence/reference/fact containers; do not use it for turn evidence when completeTurn can save evidence with the final response.',
  inputSchema: {
    type: 'object',
    properties: {
      containerPath: {
        type: 'string',
        description:
          'JSON Pointer to the target array container in the selected record, such as /refs, /evidence, /facts, or /turns/0/references. The target must be an array in the schema.'
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
        description: 'Use append to preserve existing entries, or replace when the new result set should become the entire container.'
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
      const validationIssues = validateRecord(containerSchema, nextContainer);
      if (validationIssues.length > 0) {
        return toolError(
          request.requestId,
          'INVALID_TOOL_ARGUMENTS',
          `Search results do not match the destination container schema: ${validationIssues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
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

const startTurnTool: LocalToolDefinition = {
  name: 'startTurn',
  description:
    'Start a pending conversation turn for the current user question in the selected record draft. Use this before research/reasoning when the user wants the turn recorded; after calling startTurn, call completeTurn before the final answer so the assistant response is recorded too. For role/message history arrays, this appends a user message row.',
  inputSchema: {
    type: 'object',
    properties: {
      inquiry: {
        type: 'string',
        description: 'The exact user inquiry, request, question, prompt, or message to store as the human side of the turn.'
      },
      response: {
        type: 'string',
        description:
          'Optional already-known assistant response. Omit this when you still need to search or reason; then call completeTurn before the final answer. Do not use this for role/message history arrays.'
      },
      targetPath: {
        type: 'string',
        description:
          'Optional JSON Pointer to the turn destination. Point to a turn array such as /turns or /history to append, or to a single turn object/root to merge into that object.'
      },
      fieldMapping: {
        type: 'object',
        description:
          'Optional field names to use when the schema does not use common inquiry/response names, for example { "inquiryField": "utterance", "responseField": "completion" }.',
        properties: {
          inquiryField: { type: 'string' },
          responseField: { type: 'string' }
        },
        additionalProperties: false
      },
      additionalFields: {
        type: 'object',
        description:
          'Optional schema-required fields to include in the started turn, using only known values or schema-safe empty defaults. Do not invent unavailable facts.'
      }
    },
    required: ['inquiry'],
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId || !context.selectedRecordId) {
      return toolError(request.requestId, 'NO_RECORD_SELECTED', 'No record is currently displayed in the UI.', false);
    }
    const inquiry = request.arguments.inquiry;
    const response = request.arguments.response;
    const targetPath = request.arguments.targetPath;
    const fieldMapping = request.arguments.fieldMapping;
    const additionalFields = request.arguments.additionalFields;
    if (typeof inquiry !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'inquiry must be a string.', false);
    }
    if (response !== undefined && typeof response !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'response must be a string when provided.', false);
    }
    if (targetPath !== undefined && typeof targetPath !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'targetPath must be a JSON Pointer string when provided.', false);
    }
    if (fieldMapping !== undefined && !isTurnFieldMapping(fieldMapping)) {
      return toolError(
        request.requestId,
        'INVALID_TOOL_ARGUMENTS',
        'fieldMapping must be an object with optional inquiryField and responseField string properties.',
        false
      );
    }
    if (additionalFields !== undefined && !isPlainRecord(additionalFields)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'additionalFields must be an object when provided.', false);
    }

    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      const target = resolveTurnTarget(record.schema, record.data, typeof targetPath === 'string' ? assertTurnTargetPointer(targetPath) : undefined);
      const mapping = isTurnFieldMapping(fieldMapping) ? fieldMapping : undefined;
      const fields = resolveTurnFields(target, mapping);
      const turn = buildStartedTurn(target.schema, fields, inquiry, typeof response === 'string' ? response : undefined, additionalFields);
      const { nextData, turnIndex, targetValue } = applyTurnToRecord(record.data, target, turn);
      const validationIssues = validateTurnChange(target, targetValue);
      if (validationIssues.length > 0) {
        return toolError(
          request.requestId,
          'INVALID_TOOL_ARGUMENTS',
          `Turn does not match the target schema: ${validationIssues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
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
          targetPath: target.path,
          mode: target.mode === 'append-array' ? 'append' : 'merge',
          fields,
          ...(turnIndex === undefined ? {} : { turnIndex }),
          turn,
          record: updatedRecord.data
        }
      };
    } catch (error) {
      return toolError(request.requestId, toolErrorCode(error), errorMessage(error), false);
    }
  }
};

const completeTurnTool: LocalToolDefinition = {
  name: 'completeTurn',
  description:
    'Complete a pending conversation turn after research/reasoning by saving the final assistant response and any turn-scoped evidence. Use this before the final user-facing answer whenever startTurn was used. For object turns it updates the selected turn; for role/message history arrays it appends an assistant message after the latest pending user message, or after turnIndex when provided.',
  inputSchema: {
    type: 'object',
    properties: {
      response: {
        type: 'string',
        description: 'The final assistant response, answer, reply, completion, or message to store for the turn.'
      },
      evidence: {
        type: 'array',
        description:
          'Optional supporting evidence entries found while computing the response. Each entry must match the turn evidence field schema. Prefer passing evidence here with the response instead of calling a separate persistence tool.',
        items: {}
      },
      targetPath: {
        type: 'string',
        description:
          'Optional JSON Pointer to a turn object or turn array. For object-turn arrays, provide turnIndex or omit it to use the latest turn. For role/message history arrays, omit turnIndex to answer the latest pending user message or provide turnIndex for a specific user message row.'
      },
      turnIndex: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional zero-based index. For object-turn arrays, this selects the turn object to update. For role/message history arrays, this selects the user-message row after which to insert the assistant response.'
      },
      fieldMapping: {
        type: 'object',
        description:
          'Optional response and evidence field names for object-turn schemas that do not use common response/evidence names. Not needed for role/message history arrays.',
        properties: {
          responseField: { type: 'string' },
          evidenceField: { type: 'string' }
        },
        additionalProperties: false
      },
      additionalFields: {
        type: 'object',
        description: 'Optional additional fields to merge into the turn or assistant message row while setting the response.'
      }
    },
    required: ['response'],
    additionalProperties: false
  },
  execute: async (request, context) => {
    if (!context.storage) {
      return toolError(request.requestId, 'BACKEND_UNAVAILABLE', 'No storage backend is available.', true);
    }
    if (!context.selectedProjectId || !context.selectedRecordId) {
      return toolError(request.requestId, 'NO_RECORD_SELECTED', 'No record is currently displayed in the UI.', false);
    }
    const response = request.arguments.response;
    const evidence = request.arguments.evidence;
    const targetPath = request.arguments.targetPath;
    const turnIndexArgument = request.arguments.turnIndex;
    const fieldMapping = request.arguments.fieldMapping;
    const additionalFields = request.arguments.additionalFields;
    if (typeof response !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'response must be a string.', false);
    }
    if (evidence !== undefined && !Array.isArray(evidence)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'evidence must be an array when provided.', false);
    }
    if (targetPath !== undefined && typeof targetPath !== 'string') {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'targetPath must be a JSON Pointer string when provided.', false);
    }
    if (turnIndexArgument !== undefined && (typeof turnIndexArgument !== 'number' || !Number.isInteger(turnIndexArgument) || turnIndexArgument < 0)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'turnIndex must be a non-negative integer when provided.', false);
    }
    if (fieldMapping !== undefined && !isResponseFieldMapping(fieldMapping)) {
      return toolError(
        request.requestId,
        'INVALID_TOOL_ARGUMENTS',
        'fieldMapping must be an object with optional responseField and evidenceField string properties.',
        false
      );
    }
    if (additionalFields !== undefined && !isPlainRecord(additionalFields)) {
      return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', 'additionalFields must be an object when provided.', false);
    }

    try {
      const record = await context.storage.getRecord(context.selectedProjectId, context.selectedRecordId);
      const target = resolveExistingTurnTarget(
        record.schema,
        record.data,
        typeof targetPath === 'string' ? assertTurnTargetPointer(targetPath) : undefined,
        typeof turnIndexArgument === 'number' ? turnIndexArgument : undefined
      );
      const responseField =
        'appendMessageFields' in target
          ? target.appendMessageFields.messageField
          : isResponseFieldMapping(fieldMapping) && fieldMapping.responseField
            ? fieldMapping.responseField
            : resolveResponseField(target);
      const evidenceField =
        'appendMessageFields' in target
          ? undefined
          : Array.isArray(evidence) && isResponseFieldMapping(fieldMapping) && fieldMapping.evidenceField
            ? fieldMapping.evidenceField
            : Array.isArray(evidence)
              ? resolveEvidenceField(target)
              : undefined;
      if ('appendMessageFields' in target && Array.isArray(evidence) && evidence.length > 0) {
        return toolError(
          request.requestId,
          'INVALID_TOOL_ARGUMENTS',
          'This role/message history schema has no evidence field. Save evidence separately or omit evidence.',
          false
        );
      }
      const nextTurn =
        'appendMessageFields' in target
          ? {
              ...(isPlainRecord(additionalFields) ? cloneJson(additionalFields) : {}),
              [target.appendMessageFields.roleField]: 'assistant',
              [target.appendMessageFields.messageField]: response
            }
          : {
              ...target.data,
              ...(isPlainRecord(additionalFields) ? cloneJson(additionalFields) : {}),
              ...(evidenceField ? { [evidenceField]: cloneJson(evidence) } : {}),
              [responseField]: response
            };
      const nextData = target.path === '' ? nextTurn : cloneJson(record.data);
      if ('appendMessageFields' in target) {
        const currentValue = valueAtPointer(nextData, target.path);
        if (currentValue !== undefined && !Array.isArray(currentValue)) {
          return toolError(request.requestId, 'INVALID_TOOL_ARGUMENTS', `Record value at ${target.path || '/'} is not an array container.`, false);
        }
        const currentMessages = Array.isArray(currentValue) ? currentValue : [];
        const insertIndex = target.insertAfterIndex === undefined ? currentMessages.length : target.insertAfterIndex + 1;
        setValueAtPointer(nextData, target.path, [
          ...currentMessages.slice(0, insertIndex),
          nextTurn,
          ...currentMessages.slice(insertIndex)
        ]);
      } else if (target.path !== '') {
        setValueAtPointer(nextData, target.path, nextTurn);
      }
      const validationIssues = validateRecord(target.schema, nextTurn);
      if (validationIssues.length > 0) {
        return toolError(
          request.requestId,
          'INVALID_TOOL_ARGUMENTS',
          `Response does not match the turn schema: ${validationIssues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
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
          targetPath: target.path,
          responseField,
          ...('appendMessageFields' in target ? { turnIndex: target.insertAfterIndex === undefined ? undefined : target.insertAfterIndex + 1 } : {}),
          ...(evidenceField ? { evidenceField, savedEvidenceCount: Array.isArray(evidence) ? evidence.length : 0 } : {}),
          turn: nextTurn,
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
  description: 'List Review Assistant local tools with names, descriptions, input schemas, source, and plugin metadata so you can choose the correct next tool.',
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

const builtInTools = [
  readRecordTool,
  getRecordSchemaTool,
  discoverCanonicalSchemaMappingsTool,
  saveGeneratedSchemaTool,
  saveSearchResultsTool,
  startTurnTool,
  completeTurnTool,
  listToolsTool
];

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

const discoverCanonicalSchemaMappings = (schema: unknown, config: FeedbackConfig): Record<CanonicalMapping, { candidates: CanonicalCandidate[] }> => {
  const explicitMappings = new Map<CanonicalMapping, CanonicalCandidate>();
  const explicitlyMappedPaths = new Set<string>();
  for (const entry of Object.values(config.properties)) {
    if (!entry.mapping || explicitMappings.has(entry.mapping)) {
      continue;
    }
    const candidateSchema = schemaAtPointer(schema, entry.path);
    explicitMappings.set(entry.mapping, { path: entry.path, schema: candidateSchema });
    explicitlyMappedPaths.add(entry.path);
  }
  const allCandidates = isSchema(schema) ? collectSchemaNodeCandidates(resolveSchema(schema), '') : [];
  return Object.fromEntries(
    CANONICAL_MAPPINGS.map((mapping) => {
      const explicit = explicitMappings.get(mapping);
      return [
        mapping,
        {
          candidates: explicit ? [explicit] : implicitCanonicalCandidates(mapping, allCandidates, explicitMappings, explicitlyMappedPaths)
        }
      ];
    })
  ) as Record<CanonicalMapping, { candidates: CanonicalCandidate[] }>;
};

const collectSchemaNodeCandidates = (schema: JsonSchema, path: string): SchemaNodeCandidate[] => {
  const resolved = resolveSchema(schema);
  const type = schemaType(resolved, undefined);
  const current: SchemaNodeCandidate[] = [{ path, schema: resolved, type }];
  if (type === 'object') {
    const properties = isSchemaMap(resolved.properties) ? resolved.properties : {};
    return [
      ...current,
      ...Object.entries(properties).flatMap(([key, childSchema]) =>
        collectSchemaNodeCandidates(childSchema, `${path}/${escapePointer(key)}`)
      )
    ];
  }
  if (type === 'array' && isSchema(resolved.items)) {
    return [...current, ...collectSchemaNodeCandidates(resolved.items, `${path}/*`)];
  }
  return current;
};

const implicitCanonicalCandidates = (
  mapping: CanonicalMapping,
  candidates: SchemaNodeCandidate[],
  explicitMappings: Map<CanonicalMapping, CanonicalCandidate>,
  explicitlyMappedPaths: Set<string>
): CanonicalCandidate[] => {
  const narrowed = narrowCandidatesByExplicitTurns(mapping, candidates, explicitMappings);
  return narrowed
    .filter((candidate) => !explicitlyMappedPaths.has(candidate.path))
    .filter((candidate) => canonicalShapeMatches(mapping, candidate))
    .filter((candidate) => canonicalNameMatches(mapping, candidate.path))
    .map(({ path, schema }) => ({ path, schema }));
};

const narrowCandidatesByExplicitTurns = (
  mapping: CanonicalMapping,
  candidates: SchemaNodeCandidate[],
  explicitMappings: Map<CanonicalMapping, CanonicalCandidate>
): SchemaNodeCandidate[] => {
  if (mapping === 'turns') {
    return candidates;
  }
  const turns = explicitMappings.get('turns');
  if (!turns) {
    return candidates;
  }
  const prefix = turns.path.endsWith('/*') ? turns.path : `${turns.path}/*`;
  return candidates.filter((candidate) => candidate.path.startsWith(`${prefix}/`));
};

const canonicalShapeMatches = (mapping: CanonicalMapping, candidate: SchemaNodeCandidate): boolean => {
  if (mapping === 'request' || mapping === 'response') {
    return candidate.type === 'string';
  }
  if (mapping === 'turns') {
    return candidate.type === 'array' && isSchema(resolveSchema(candidate.schema).items) && schemaType(resolveSchema(resolveSchema(candidate.schema).items as JsonSchema), undefined) === 'object';
  }
  if (mapping === 'evidence') {
    return candidate.type === 'array' && isSchema(resolveSchema(candidate.schema).items) && schemaType(resolveSchema(resolveSchema(candidate.schema).items as JsonSchema), undefined) === 'object';
  }
  if (mapping === 'facts' || mapping === 'tags') {
    if (candidate.type !== 'array' || !isSchema(resolveSchema(candidate.schema).items)) {
      return false;
    }
    const itemType = schemaType(resolveSchema(resolveSchema(candidate.schema).items as JsonSchema), undefined);
    return itemType === 'object' || itemType === 'string';
  }
  return false;
};

const canonicalNameMatches = (mapping: CanonicalMapping, path: string): boolean => {
  const normalizedSegments = pointerSegments(path).map(normalizeTurnField);
  const last = normalizedSegments.at(-1) ?? '';
  if (mapping === 'turns') {
    return ['turn', 'turns', 'conversation', 'conversations', 'message', 'messages', 'history'].includes(last);
  }
  if (mapping === 'request') {
    return inquiryFieldAliases.map(normalizeTurnField).includes(last);
  }
  if (mapping === 'response') {
    return responseFieldAliases.map(normalizeTurnField).includes(last);
  }
  if (mapping === 'evidence') {
    return evidenceFieldAliases.map(normalizeTurnField).includes(last);
  }
  return last === mapping;
};

const resolveTurnTarget = (schema: unknown, data: unknown, targetPath: string | undefined): TurnTargetCandidate => {
  if (!isSchema(schema)) {
    throw new Error('Project config/schema.json must be a JSON object.');
  }
  if (targetPath !== undefined) {
    return turnTargetAtPointer(schema, data, targetPath);
  }
  const candidates = listTurnTargetCandidates(schema, data)
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length === 0) {
    throw new Error('No turn target could be inferred. Read the record schema and call startTurn with targetPath and fieldMapping.');
  }
  const [best, second] = candidates;
  if (!best.inquiryField || !best.responseField || (second && second.score === best.score)) {
    throw new Error(
      `Turn target is ambiguous. Call startTurn with targetPath and fieldMapping. Candidate targets: ${candidates
        .slice(0, 5)
        .map(formatTurnTargetCandidate)
        .join('; ')}`
    );
  }
  return best;
};

const turnTargetAtPointer = (schema: unknown, data: unknown, path: string): TurnTargetCandidate => {
  const targetSchema = schemaAtPointer(schema, path);
  const resolved = resolveSchema(targetSchema);
  if (isArraySchema(resolved)) {
    if (!isSchema(resolved.items)) {
      throw new Error(`Schema at ${path || '/'} does not define object item schemas.`);
    }
    const currentValue = valueAtPointer(data, path);
    if (currentValue !== undefined && !Array.isArray(currentValue)) {
      throw new Error(`Record value at ${path || '/'} is not an array container.`);
    }
    const itemSchema = resolveSchema(resolved.items);
    return {
      path,
      mode: 'append-array',
      schema: itemSchema,
      containerSchema: resolved,
      data: undefined,
      ...scoreTurnTarget(path, itemSchema, undefined, 'append-array')
    };
  }
  if (schemaType(resolved, valueAtPointer(data, path)) !== 'object') {
    throw new Error(`Schema at ${path || '/'} is not an object or array turn target.`);
  }
  const currentValue = valueAtPointer(data, path);
  if (currentValue !== undefined && !isPlainRecord(currentValue)) {
    throw new Error(`Record value at ${path || '/'} is not an object turn target.`);
  }
  return {
    path,
    mode: 'merge-object',
    schema: resolved,
    data: currentValue,
    ...scoreTurnTarget(path, resolved, currentValue, 'merge-object')
  };
};

const listTurnTargetCandidates = (schema: unknown, data: unknown): TurnTargetCandidate[] => {
  if (!isSchema(schema)) {
    return [];
  }
  return collectTurnTargets(resolveSchema(schema), data, '');
};

const collectTurnTargets = (schema: JsonSchema, data: unknown, path: string): TurnTargetCandidate[] => {
  const resolved = resolveSchema(schema);
  const type = schemaType(resolved, data);
  const current: TurnTargetCandidate[] = [];
  if (type === 'object') {
    current.push({
      path,
      mode: 'merge-object',
      schema: resolved,
      data,
      ...scoreTurnTarget(path, resolved, data, 'merge-object')
    });
    const properties = isSchemaMap(resolved.properties) ? resolved.properties : {};
    const value = isPlainRecord(data) ? data : {};
    return [
      ...current,
      ...Object.entries(properties).flatMap(([key, childSchema]) =>
        collectTurnTargets(childSchema, value[key], `${path}/${escapePointer(key)}`)
      )
    ];
  }
  if (type === 'array' && isSchema(resolved.items)) {
    const itemSchema = resolveSchema(resolved.items);
    current.push({
      path,
      mode: 'append-array',
      schema: itemSchema,
      containerSchema: resolved,
      data: undefined,
      ...scoreTurnTarget(path, itemSchema, undefined, 'append-array')
    });
    if (Array.isArray(data)) {
      return [
        ...current,
        ...data.flatMap((item, index) => collectTurnTargets(itemSchema, item, `${path}/${index}`))
      ];
    }
  }
  return current;
};

const scoreTurnTarget = (
  path: string,
  schema: JsonSchema,
  data: unknown,
  mode: TurnTargetMode
): Pick<TurnTargetCandidate, 'score' | 'inquiryField' | 'responseField' | 'roleField' | 'messageField'> => {
  const properties = isSchemaMap(schema.properties) ? schema.properties : {};
  const dataKeys = isPlainRecord(data) ? Object.keys(data) : [];
  const propertyKeys = Object.keys(properties);
  const keys = [...new Set([...propertyKeys, ...dataKeys])];
  const inquiryField = bestTurnField(keys, inquiryFieldAliases);
  const responseField = bestTurnField(keys, responseFieldAliases);
  const messageHistoryFields = detectMessageHistoryFields(schema);
  const pathScore = turnPathScore(path);
  const schemaScore = schemaTitleScore(schema);
  const pairScore = messageHistoryFields ? 100 : inquiryField && responseField ? 100 : inquiryField || responseField ? 20 : 0;
  const modeScore = mode === 'append-array' ? 10 : 0;
  const requiredScore = requiredTurnFieldScore(schema, inquiryField, responseField);
  return {
    score: pairScore + pathScore + schemaScore + modeScore + requiredScore,
    inquiryField: messageHistoryFields?.messageField ?? inquiryField,
    responseField: messageHistoryFields?.messageField ?? responseField,
    ...(messageHistoryFields ? { roleField: messageHistoryFields.roleField, messageField: messageHistoryFields.messageField } : {})
  };
};

const resolveTurnFields = (
  target: TurnTargetCandidate,
  fieldMapping: TurnFieldMapping | undefined
): ResolvedTurnFields => {
  if (target.roleField && target.messageField && !fieldMapping?.inquiryField && !fieldMapping?.responseField) {
    return {
      inquiryField: target.messageField,
      responseField: target.messageField,
      roleField: target.roleField,
      messageField: target.messageField
    };
  }
  const inquiryField = fieldMapping?.inquiryField ?? target.inquiryField ?? defaultTurnField(target, inquiryFieldAliases, 'request');
  const responseField = fieldMapping?.responseField ?? target.responseField ?? defaultTurnField(target, responseFieldAliases, 'response');
  if (inquiryField === responseField) {
    throw new Error('fieldMapping inquiryField and responseField must be different.');
  }
  return { inquiryField, responseField };
};

const buildStartedTurn = (
  schema: JsonSchema,
  fields: ResolvedTurnFields,
  inquiry: string,
  response: string | undefined,
  additionalFields: unknown
): Record<string, unknown> => {
  if (fields.roleField && fields.messageField) {
    if (response !== undefined) {
      throw new Error('Role/message history turns store the assistant response with completeTurn, not startTurn.');
    }
    return {
      ...(isPlainRecord(additionalFields) ? cloneJson(additionalFields) : {}),
      [fields.roleField]: 'user',
      [fields.messageField]: inquiry
    };
  }
  const turn: Record<string, unknown> = {
    ...(isPlainRecord(additionalFields) ? cloneJson(additionalFields) : {}),
    [fields.inquiryField]: inquiry
  };
  if (response !== undefined) {
    turn[fields.responseField] = response;
  } else if (isRequiredField(schema, fields.responseField)) {
    turn[fields.responseField] = '';
  }
  return turn;
};

const resolveExistingTurnTarget = (schema: unknown, data: unknown, targetPath: string | undefined, turnIndex: number | undefined): ExistingTurnTarget => {
  if (targetPath !== undefined) {
    const targetSchema = schemaAtPointer(schema, targetPath);
    const resolved = resolveSchema(targetSchema);
    if (isArraySchema(resolved)) {
      if (!isSchema(resolved.items)) {
        throw new Error(`Schema at ${targetPath || '/'} does not define object item schemas.`);
      }
      const itemSchema = resolveSchema(resolved.items);
      const messageHistoryFields = detectMessageHistoryFields(itemSchema);
      if (messageHistoryFields) {
        const messages = valueAtPointer(data, targetPath);
        const insertAfterIndex = resolvePendingUserMessageIndex(messages, messageHistoryFields, turnIndex);
        return { path: targetPath, schema: itemSchema, data: undefined, appendMessageFields: messageHistoryFields, insertAfterIndex };
      }
      if (turnIndex === undefined) {
        throw new Error('turnIndex is required when targetPath points to a turn array.');
      }
      const turnPath = `${targetPath}/${turnIndex}`;
      const turn = valueAtPointer(data, turnPath);
      if (!isPlainRecord(turn)) {
        throw new Error(`Record value at ${turnPath || '/'} is not an object turn target.`);
      }
      return { path: turnPath, schema: itemSchema, data: cloneJson(turn) };
    }
    if (turnIndex !== undefined) {
      throw new Error('turnIndex can only be used when targetPath points to a turn array.');
    }
    const turn = valueAtPointer(data, targetPath);
    if (!isPlainRecord(turn)) {
      throw new Error(`Record value at ${targetPath || '/'} is not an object turn target.`);
    }
    return { path: targetPath, schema: resolved, data: cloneJson(turn) };
  }

  const candidates = listTurnTargetCandidates(schema, data)
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  for (const candidate of candidates) {
    if (candidate.mode === 'append-array') {
      if (candidate.roleField && candidate.messageField) {
        const messages = valueAtPointer(data, candidate.path);
        const insertAfterIndex = resolvePendingUserMessageIndex(messages, { roleField: candidate.roleField, messageField: candidate.messageField }, turnIndex);
        return {
          path: candidate.path,
          schema: candidate.schema,
          data: undefined,
          appendMessageFields: { roleField: candidate.roleField, messageField: candidate.messageField },
          insertAfterIndex
        };
      }
      const turns = valueAtPointer(data, candidate.path);
      if (Array.isArray(turns) && turns.length > 0) {
        const index = turnIndex ?? turns.length - 1;
        const turn = turns[index];
        if (isPlainRecord(turn)) {
          return { path: `${candidate.path}/${index}`, schema: candidate.schema, data: cloneJson(turn) };
        }
      }
    } else if (isPlainRecord(candidate.data)) {
      return { path: candidate.path, schema: candidate.schema, data: cloneJson(candidate.data) };
    }
  }
  throw new Error('No existing turn could be inferred. Call completeTurn with targetPath and, for arrays, turnIndex.');
};

const resolveResponseField = (target: ExistingTurnTarget): string => {
  if ('appendMessageFields' in target) {
    return target.appendMessageFields.messageField;
  }
  const schemaFields = isSchemaMap(target.schema.properties) ? Object.keys(target.schema.properties) : [];
  return bestTurnField([...new Set([...schemaFields, ...Object.keys(target.data)])], responseFieldAliases) ?? 'response';
};

const resolveEvidenceField = (target: ExistingTurnTarget): string => {
  if ('appendMessageFields' in target) {
    throw new Error('No evidence field could be inferred for this role/message history turn.');
  }
  const schemaFields = isSchemaMap(target.schema.properties) ? Object.keys(target.schema.properties) : [];
  const evidenceField = bestTurnField([...new Set([...schemaFields, ...Object.keys(target.data)])], evidenceFieldAliases);
  if (!evidenceField) {
    throw new Error('No evidence field could be inferred for this turn. Call completeTurn with fieldMapping.evidenceField.');
  }
  return evidenceField;
};

const defaultTurnField = (target: TurnTargetCandidate, aliases: string[], fallback: string): string => {
  const properties = isSchemaMap(target.schema.properties) ? Object.keys(target.schema.properties) : [];
  const dataKeys = isPlainRecord(target.data) ? Object.keys(target.data) : [];
  return bestTurnField([...new Set([...properties, ...dataKeys])], aliases) ?? fallback;
};

const applyTurnToRecord = (
  data: unknown,
  target: TurnTargetCandidate,
  turn: Record<string, unknown>
): { nextData: unknown; targetValue: unknown; turnIndex?: number } => {
  const nextData = cloneJson(data);
  if (target.mode === 'append-array') {
    const currentValue = valueAtPointer(nextData, target.path);
    if (currentValue !== undefined && !Array.isArray(currentValue)) {
      throw new Error(`Record value at ${target.path || '/'} is not an array container.`);
    }
    const nextContainer = [...(Array.isArray(currentValue) ? currentValue : []), turn];
    if (target.path === '') {
      return { nextData: nextContainer, targetValue: nextContainer, turnIndex: nextContainer.length - 1 };
    }
    setValueAtPointer(nextData, target.path, nextContainer);
    return { nextData, targetValue: nextContainer, turnIndex: nextContainer.length - 1 };
  }
  const currentValue = target.path === '' ? nextData : valueAtPointer(nextData, target.path);
  if (currentValue !== undefined && !isPlainRecord(currentValue)) {
    throw new Error(`Record value at ${target.path || '/'} is not an object turn target.`);
  }
  const nextObject = { ...(isPlainRecord(currentValue) ? currentValue : {}), ...turn };
  if (target.path === '') {
    return { nextData: nextObject, targetValue: nextObject };
  }
  setValueAtPointer(nextData, target.path, nextObject);
  return { nextData, targetValue: nextObject };
};

const validateTurnChange = (target: TurnTargetCandidate, targetValue: unknown): ReturnType<typeof validateRecord> =>
  validateRecord(target.mode === 'append-array' ? (target.containerSchema ?? { type: 'array', items: target.schema }) : target.schema, targetValue);

const inquiryFieldAliases = [
  'inquiry',
  'request',
  'question',
  'prompt',
  'query',
  'input',
  'userMessage',
  'user',
  'human',
  'utterance',
  'ask'
];

const responseFieldAliases = [
  'response',
  'answer',
  'reply',
  'completion',
  'output',
  'agentResponse',
  'assistantMessage',
  'assistant',
  'agent',
  'result'
];

const evidenceFieldAliases = ['evidence', 'references', 'sources', 'citations', 'supportingEvidence', 'searchResults', 'results', 'documents'];
const messageFieldAliases = ['msg', 'message', 'content', 'text', 'body'];

const bestTurnField = (fields: string[], aliases: string[]): string | undefined => {
  const normalizedAliases = aliases.map(normalizeTurnField);
  return fields.find((field) => normalizedAliases.includes(normalizeTurnField(field)));
};

const detectMessageHistoryFields = (schema: JsonSchema): MessageHistoryFields | undefined => {
  const properties = isSchemaMap(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  const roleField = bestTurnField(keys, ['role', 'speaker', 'author']);
  const messageField = bestTurnField(keys, messageFieldAliases);
  if (!roleField || !messageField || roleField === messageField) {
    return undefined;
  }
  const roleSchema = resolveSchema(properties[roleField]);
  const messageSchema = resolveSchema(properties[messageField]);
  const roleEnum = Array.isArray(roleSchema.enum) ? roleSchema.enum : [];
  const supportsUserAndAssistant =
    roleEnum.length === 0 || (roleEnum.includes('user') && roleEnum.includes('assistant'));
  if (!supportsUserAndAssistant || schemaType(messageSchema, undefined) !== 'string') {
    return undefined;
  }
  return { roleField, messageField };
};

const resolvePendingUserMessageIndex = (
  messages: unknown,
  fields: MessageHistoryFields,
  requestedIndex: number | undefined
): number | undefined => {
  if (messages === undefined) {
    if (requestedIndex !== undefined) {
      throw new Error(`Record value at turnIndex ${requestedIndex} is not a user message.`);
    }
    throw new Error('No pending user message could be inferred for this role/message history.');
  }
  if (!Array.isArray(messages)) {
    throw new Error('Record value at the history path is not an array container.');
  }
  if (requestedIndex !== undefined) {
    assertUserMessageAtIndex(messages, fields, requestedIndex);
    return requestedIndex;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isPlainRecord(message) && message[fields.roleField] === 'assistant') {
      throw new Error('No pending user message could be inferred for this role/message history.');
    }
    if (isPlainRecord(message) && message[fields.roleField] === 'user') {
      return index;
    }
  }
  throw new Error('No pending user message could be inferred for this role/message history.');
};

const assertUserMessageAtIndex = (messages: unknown[], fields: MessageHistoryFields, index: number): void => {
  const message = messages[index];
  if (!isPlainRecord(message) || message[fields.roleField] !== 'user') {
    throw new Error(`Record value at turnIndex ${index} is not a user message.`);
  }
};

const normalizeTurnField = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const turnPathScore = (path: string): number => {
  const normalizedSegments = pointerSegments(path).map(normalizeTurnField);
  if (normalizedSegments.some((segment) => ['turn', 'turns'].includes(segment))) {
    return 40;
  }
  if (normalizedSegments.some((segment) => ['conversation', 'conversations', 'message', 'messages', 'chat', 'transcript', 'history'].includes(segment))) {
    return 25;
  }
  return 0;
};

const schemaTitleScore = (schema: JsonSchema): number => {
  const text = [schema.title, schema.description].filter((value): value is string => typeof value === 'string').join(' ');
  const normalized = normalizeTurnField(text);
  if (normalized.includes('turn')) {
    return 20;
  }
  if (['conversation', 'message', 'chat', 'transcript'].some((term) => normalized.includes(term))) {
    return 10;
  }
  return 0;
};

const requiredTurnFieldScore = (schema: JsonSchema, inquiryField: string | undefined, responseField: string | undefined): number => {
  if (!Array.isArray(schema.required)) {
    return 0;
  }
  const required = schema.required.filter((value): value is string => typeof value === 'string');
  return (inquiryField && required.includes(inquiryField) ? 10 : 0) + (responseField && required.includes(responseField) ? 10 : 0);
};

const isRequiredField = (schema: JsonSchema, field: string): boolean =>
  Array.isArray(schema.required) && schema.required.some((value) => value === field);

const formatTurnTargetCandidate = (candidate: TurnTargetCandidate): string => {
  const fields = [candidate.inquiryField, candidate.responseField].filter((field): field is string => Boolean(field)).join('/');
  return `${candidate.path || '/'} (${candidate.mode}${fields ? `, ${fields}` : ''})`;
};

const toTurnCandidateResult = (candidate: TurnTargetCandidate): Record<string, unknown> => ({
  path: candidate.path,
  mode: candidate.mode === 'append-array' ? 'append' : 'merge',
  score: candidate.score,
  schema: candidate.schema,
  fields: {
    inquiryField: candidate.inquiryField,
    responseField: candidate.responseField
  }
});

const schemaAtPointer = (schema: unknown, path: string): JsonSchema => {
  if (!isSchema(schema)) {
    throw new Error('Project config/schema.json must be a JSON object.');
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
        throw new Error(`Record path ${path || '/'} does not exist.`);
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

const assertTurnTargetPointer = (value: string): string => {
  if (value === '') {
    return value;
  }
  if (!value.startsWith('/')) {
    throw new Error('targetPath must be a JSON Pointer beginning with /.');
  }
  pointerSegments(value);
  return value;
};

const assertSchemaPointer = (value: string): string => {
  if (value === '') {
    return value;
  }
  if (!value.startsWith('/')) {
    throw new Error('targetPath must be a JSON Pointer beginning with /.');
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

const isTurnFieldMapping = (value: unknown): value is TurnFieldMapping => {
  if (!isPlainRecord(value)) {
    return false;
  }
  const allowedKeys = ['inquiryField', 'responseField'];
  return Object.entries(value).every(([key, field]) => allowedKeys.includes(key) && typeof field === 'string' && field.trim() !== '');
};

const isResponseFieldMapping = (value: unknown): value is Pick<TurnFieldMapping, 'responseField' | 'evidenceField'> => {
  if (!isPlainRecord(value)) {
    return false;
  }
  const allowedKeys = ['responseField', 'evidenceField'];
  return Object.entries(value).every(([key, field]) => allowedKeys.includes(key) && typeof field === 'string' && field.trim() !== '');
};

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
    message.includes('schema.json') ||
    message.includes('record path') ||
    message.includes('targetpath') ||
    message.includes('turn target') ||
    message.includes('turnindex') ||
    message.includes('existing turn') ||
    message.includes('fieldmapping') ||
    message.includes('turn does not')
  ) {
    return 'INVALID_TOOL_ARGUMENTS';
  }
  return 'PROVIDER_ERROR';
};
