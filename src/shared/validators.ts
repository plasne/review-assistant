import type {
  AgentErrorEnvelope,
  AgentStatusSnapshot,
  AppBootstrap,
  ChatCanceled,
  ChatCancelResult,
  ChatStreamChunk,
  ChatStreamComplete,
  ChatStreamError,
  ChatStreamStartResult,
  OpenProjectResult,
  ProjectSummary,
  RecordDetail,
  RecordSummary
} from './types';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

export const assertProjectId = (value: unknown): string => {
  if (!isString(value) || value.trim() === '' || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new ValidationError('Invalid project identifier.');
  }
  return value;
};

export const assertNewProjectId = (value: unknown): string => {
  if (!isString(value)) {
    throw new ValidationError('Project name is required.');
  }
  const projectId = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(projectId)) {
    throw new ValidationError('Project name must be 3-63 characters using lowercase letters, numbers, and hyphens.');
  }
  return projectId;
};

export const assertRecordId = (value: unknown): string => {
  if (!isString(value) || value.trim() === '' || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new ValidationError('Invalid record identifier.');
  }
  return value;
};

export const assertChatMessage = (value: unknown): string => {
  if (!isString(value) || value.trim() === '' || value.length > 20000) {
    throw new ValidationError('Chat message must be non-empty and under 20,000 characters.');
  }
  return value;
};

export const assertProjectSummary = (value: unknown): ProjectSummary => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) {
    throw new ValidationError('Invalid project response.');
  }
  return { id: value.id, name: value.name };
};

export const assertProjectSummaries = (value: unknown): ProjectSummary[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError('Invalid projects response.');
  }
  return value.map(assertProjectSummary);
};

const assertRecordSummary = (value: unknown): RecordSummary => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.displayName)) {
    throw new ValidationError('Invalid record response.');
  }
  return { id: value.id, displayName: value.displayName };
};

export const assertOpenProjectResult = (value: unknown): OpenProjectResult => {
  if (!isRecord(value) || !isRecord(value.projectConfig) || !Array.isArray(value.records)) {
    throw new ValidationError('Invalid open project response.');
  }
  return {
    project: assertProjectSummary(value.project),
    schema: value.schema,
    records: value.records.map(assertRecordSummary),
    projectConfig: Object.fromEntries(Object.entries(value.projectConfig).filter((entry): entry is [string, string] => isString(entry[1])))
  };
};

export const assertRecordDetail = (value: unknown): RecordDetail => {
  if (!isRecord(value) || !isString(value.projectId) || !isString(value.recordId) || !isString(value.displayName)) {
    throw new ValidationError('Invalid record detail response.');
  }
  if (!Array.isArray(value.validationIssues) || !isRecord(value.renderTree)) {
    throw new ValidationError('Invalid record validation response.');
  }
  return value as RecordDetail;
};

export const assertBootstrap = (value: unknown): AppBootstrap => {
  if (!isRecord(value) || !Array.isArray(value.projects) || !isString(value.version)) {
    throw new ValidationError('Invalid bootstrap response.');
  }
  return value as AppBootstrap;
};

export const assertAgentError = (value: unknown): AgentErrorEnvelope => {
  if (!isRecord(value) || !isString(value.code) || !isString(value.message) || typeof value.retryable !== 'boolean') {
    throw new ValidationError('Invalid agent error response.');
  }
  return value as AgentErrorEnvelope;
};

export const assertAgentStatus = (value: unknown): AgentStatusSnapshot => {
  if (!isRecord(value) || !isRecord(value.provider) || !isString(value.provider.id) || !isString(value.provider.name)) {
    throw new ValidationError('Invalid agent status response.');
  }
  if (value.availability !== 'ready' && value.availability !== 'unavailable') {
    throw new ValidationError('Invalid agent availability response.');
  }
  if (value.error !== undefined) {
    assertAgentError(value.error);
  }
  return value as AgentStatusSnapshot;
};

export const assertChatStreamStart = (value: unknown): ChatStreamStartResult => {
  if (!isRecord(value) || !isString(value.requestId) || !isString(value.messageId)) {
    throw new ValidationError('Invalid chat stream start response.');
  }
  return value as ChatStreamStartResult;
};

export const assertChatStreamChunk = (value: unknown): ChatStreamChunk => {
  if (!isRecord(value) || !isString(value.requestId) || !isString(value.messageId) || !isString(value.content)) {
    throw new ValidationError('Invalid chat stream chunk response.');
  }
  return value as ChatStreamChunk;
};

export const assertChatStreamComplete = (value: unknown): ChatStreamComplete => {
  if (!isRecord(value) || !isString(value.requestId) || !isString(value.messageId)) {
    throw new ValidationError('Invalid chat stream completion response.');
  }
  return value as ChatStreamComplete;
};

export const assertChatStreamError = (value: unknown): ChatStreamError => {
  if (!isRecord(value) || !isString(value.requestId)) {
    throw new ValidationError('Invalid chat stream error response.');
  }
  if (value.messageId !== undefined && !isString(value.messageId)) {
    throw new ValidationError('Invalid chat stream error message identifier.');
  }
  assertAgentError(value.error);
  return value as ChatStreamError;
};

export const assertChatCancelResult = (value: unknown): ChatCancelResult => {
  if (!isRecord(value) || !isString(value.requestId) || typeof value.canceled !== 'boolean') {
    throw new ValidationError('Invalid chat cancel response.');
  }
  return value as ChatCancelResult;
};

export const assertChatCanceled = (value: unknown): ChatCanceled => {
  if (!isRecord(value) || !isString(value.requestId)) {
    throw new ValidationError('Invalid chat canceled response.');
  }
  if (value.messageId !== undefined && !isString(value.messageId)) {
    throw new ValidationError('Invalid chat canceled message identifier.');
  }
  return value as ChatCanceled;
};
