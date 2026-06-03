import type {
  AgentErrorEnvelope,
  AgentStatusSnapshot,
  AppBootstrap,
  ChatAttachment,
  ChatAttachmentContent,
  ChatAttachmentSelectionResult,
  ChatCanceled,
  ChatCancelResult,
  ChatMessage,
  ContinueWithGitHubResult,
  ChatStreamChunk,
  ChatStreamComplete,
  ChatStreamError,
  ChatStreamStartResult,
  FeedbackConfig,
  FeedbackSubmissionInput,
  FeedbackSubmissionResult,
  GitHubLoginCompletion,
  OpenProjectResult,
  ProjectUser,
  ProjectSummary,
  RecordDraftStatus,
  RecordDetail,
  RecordSummary
} from './types';
import { FEEDBACK_EDIT_MODES, FEEDBACK_MODES } from './feedback';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const MAX_CHAT_ATTACHMENTS = 5;
const MAX_CHAT_ATTACHMENT_CONTENT_CHARS = 60_000;
const MAX_CHAT_ATTACHMENT_TOTAL_CHARS = 60_000;

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

export const assertChatHistory = (value: unknown): ChatMessage[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 40) {
    throw new ValidationError('Chat history must be an array with at most 40 messages.');
  }
  let totalChars = 0;
  return value.map((message) => {
    if (!isRecord(message) || !isString(message.id) || !isString(message.content) || !isString(message.createdAt)) {
      throw new ValidationError('Invalid chat history message.');
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new ValidationError('Chat history can only include user and assistant messages.');
    }
    if (message.content.trim() === '' || message.content.length > 20000) {
      throw new ValidationError('Chat history messages must be non-empty and under 20,000 characters.');
    }
    totalChars += message.content.length;
    if (totalChars > 80000) {
      throw new ValidationError('Chat history must be under 80,000 characters.');
    }
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    };
  });
};

const assertChatAttachmentMetadata = (value: unknown): ChatAttachment => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.path)) {
    throw new ValidationError('Invalid chat attachment.');
  }
  if (value.id.trim() === '' || value.name.trim() === '' || value.path.trim() === '') {
    throw new ValidationError('Chat attachment metadata must be non-empty.');
  }
  if (typeof value.sizeBytes !== 'number' || !Number.isFinite(value.sizeBytes) || value.sizeBytes < 0) {
    throw new ValidationError('Chat attachment size must be a non-negative number.');
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    sizeBytes: value.sizeBytes
  };
};

export const assertChatAttachments = (value: unknown): ChatAttachment[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) {
    throw new ValidationError(`Chat attachments must include at most ${MAX_CHAT_ATTACHMENTS} files.`);
  }
  return value.map(assertChatAttachmentMetadata);
};

export const assertChatAttachmentContents = (value: unknown): ChatAttachmentContent[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) {
    throw new ValidationError(`Chat attachments must include at most ${MAX_CHAT_ATTACHMENTS} files.`);
  }
  let totalChars = 0;
  return value.map((attachment) => {
    const metadata = assertChatAttachmentMetadata(attachment);
    if (!isRecord(attachment) || !isString(attachment.content) || attachment.content.length > MAX_CHAT_ATTACHMENT_CONTENT_CHARS) {
      throw new ValidationError('Chat attachment content must be text under 60,000 characters.');
    }
    totalChars += attachment.content.length;
    if (totalChars > MAX_CHAT_ATTACHMENT_TOTAL_CHARS) {
      throw new ValidationError('Chat attachment content must be under 60,000 total characters.');
    }
    return { ...metadata, content: attachment.content };
  });
};

export const assertChatAttachmentSelectionResult = (value: unknown): ChatAttachmentSelectionResult => {
  if (!isRecord(value)) {
    throw new ValidationError('Invalid chat attachment selection response.');
  }
  return { attachments: assertChatAttachments(value.attachments) };
};

export const assertChatAttachmentId = (value: unknown): string => {
  if (!isString(value) || value.trim() === '') {
    throw new ValidationError('Invalid chat attachment identifier.');
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
    projectConfig: Object.fromEntries(Object.entries(value.projectConfig).filter((entry): entry is [string, string] => isString(entry[1]))),
    ...(value.feedbackConfig === undefined ? {} : { feedbackConfig: assertFeedbackConfig(value.feedbackConfig) })
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

export const assertRecordDraftStatus = (value: unknown): RecordDraftStatus => {
  if (!isRecord(value) || typeof value.hasUnsavedChanges !== 'boolean') {
    throw new ValidationError('Invalid record draft status response.');
  }
  return { hasUnsavedChanges: value.hasUnsavedChanges };
};

export const assertFeedbackConfig = (value: unknown): FeedbackConfig => {
  if (!isRecord(value) || !isRecord(value.properties)) {
    throw new ValidationError('Invalid feedback configuration response.');
  }
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([path, entry]) => {
      if (!isRecord(entry) || !isString(entry.path) || !isString(entry.target) || !isString(entry.tab)) {
        throw new ValidationError('Invalid feedback configuration entry.');
      }
      if (entry.path !== path || !FEEDBACK_MODES.includes(entry.feedback as FeedbackConfig['properties'][string]['feedback'])) {
        throw new ValidationError('Invalid feedback mode.');
      }
      if (typeof entry.comments !== 'boolean' || !FEEDBACK_EDIT_MODES.includes(entry.editMode as FeedbackConfig['properties'][string]['editMode'])) {
        throw new ValidationError('Invalid feedback configuration flags.');
      }
      return [
        path,
        {
          path,
          target: entry.target,
          tab: entry.tab,
          supportsEdit: entry.supportsEdit !== false,
          feedback: entry.feedback,
          comments: entry.comments,
          editMode: entry.supportsEdit === false ? 'none' : entry.editMode
        }
      ];
    })
  );
  return { properties } as FeedbackConfig;
};

export const assertProjectUser = (value: unknown): ProjectUser => {
  if (!isRecord(value) || typeof value.valid !== 'boolean') {
    throw new ValidationError('Invalid project user response.');
  }
  if (value.username !== undefined && !isString(value.username)) {
    throw new ValidationError('Invalid project username response.');
  }
  if (value.validationMessage !== undefined && !isString(value.validationMessage)) {
    throw new ValidationError('Invalid project user validation response.');
  }
  return value as ProjectUser;
};

export const assertFeedbackSubmissionInput = (value: unknown): FeedbackSubmissionInput => {
  if (!isRecord(value) || !isString(value.propertyPath) || !value.propertyPath.startsWith('/')) {
    throw new ValidationError('Invalid feedback submission target.');
  }
  for (const key of ['feedbackValue', 'commentValue', 'editValue']) {
    if (value[key] !== undefined && !isString(value[key])) {
      throw new ValidationError('Feedback submission values must be strings.');
    }
  }
  return {
    propertyPath: value.propertyPath,
    feedbackValue: value.feedbackValue as string | undefined,
    commentValue: value.commentValue as string | undefined,
    editValue: value.editValue as string | undefined
  };
};

export const assertFeedbackSubmissionResult = (value: unknown): FeedbackSubmissionResult => {
  if (!isRecord(value) || !isString(value.username)) {
    throw new ValidationError('Invalid feedback submission response.');
  }
  return { username: value.username, record: assertRecordDetail(value.record) };
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

export const assertContinueWithGitHubResult = (value: unknown): ContinueWithGitHubResult => {
  if (!isRecord(value) || !isString(value.loginId) || typeof value.opened !== 'boolean') {
    throw new ValidationError('Invalid GitHub continuation response.');
  }
  if (value.deviceCode !== undefined && !isString(value.deviceCode)) {
    throw new ValidationError('Invalid GitHub continuation device code.');
  }
  if (value.verificationUri !== undefined && !isString(value.verificationUri)) {
    throw new ValidationError('Invalid GitHub continuation verification URI.');
  }
  if (value.copiedToClipboard !== undefined && typeof value.copiedToClipboard !== 'boolean') {
    throw new ValidationError('Invalid GitHub continuation clipboard status.');
  }
  return value as ContinueWithGitHubResult;
};

export const assertGitHubLoginCompletion = (value: unknown): GitHubLoginCompletion => {
  if (!isRecord(value) || !isString(value.loginId) || typeof value.success !== 'boolean') {
    throw new ValidationError('Invalid GitHub login completion response.');
  }
  if (value.errorMessage !== undefined && !isString(value.errorMessage)) {
    throw new ValidationError('Invalid GitHub login completion error.');
  }
  return value as GitHubLoginCompletion;
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
