import type {
  AgentErrorEnvelope,
  AgentSettings,
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
  RecordSaveResult,
  RecordSummary,
  TagDefinition,
  Theme,
  ThemeState,
  ThemeTokens
} from './types';
import { CANONICAL_MAPPINGS, FEEDBACK_EDIT_MODES, FEEDBACK_MODES, FIELD_PRESENTATIONS } from './feedback';

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
const REQUIRED_THEME_TOKEN_KEYS = [
  'bg',
  'bg2',
  'surface',
  'surface2',
  'border',
  'text',
  'textDim',
  'accent',
  'accent2',
  'success',
  'warning',
  'danger',
  'focusRing',
  'fontSans'
] as const satisfies readonly (keyof ThemeTokens)[];

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

export const assertThemeId = (value: unknown): string => {
  if (!isString(value) || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value)) {
    throw new ValidationError('Theme identifier must be 3-63 characters using lowercase letters, numbers, and hyphens.');
  }
  return value;
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

const assertTagDefinition = (value: unknown): TagDefinition => {
  if (!isRecord(value) || !isString(value.name) || !isString(value.description)) {
    throw new ValidationError('Invalid tag definition response.');
  }
  return { name: value.name, description: value.description };
};

export const assertOpenProjectResult = (value: unknown): OpenProjectResult => {
  if (!isRecord(value) || !isRecord(value.projectConfig) || !Array.isArray(value.records)) {
    throw new ValidationError('Invalid open project response.');
  }
  if (value.tagDefinitions !== undefined && !Array.isArray(value.tagDefinitions)) {
    throw new ValidationError('Invalid tag definitions response.');
  }
  return {
    project: assertProjectSummary(value.project),
    schema: value.schema,
    records: value.records.map(assertRecordSummary),
    projectConfig: Object.fromEntries(Object.entries(value.projectConfig).filter((entry): entry is [string, string] => isString(entry[1]))),
    ...(value.feedbackConfig === undefined ? {} : { feedbackConfig: assertFeedbackConfig(value.feedbackConfig) }),
    ...(value.tagDefinitions === undefined ? {} : { tagDefinitions: value.tagDefinitions.map(assertTagDefinition) })
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

export const assertRecordSaveResult = (value: unknown): RecordSaveResult => {
  if (!isRecord(value)) {
    throw new ValidationError('Invalid record save response.');
  }
  if (value.tagPluginWarning !== undefined && !isString(value.tagPluginWarning)) {
    throw new ValidationError('Invalid record save warning response.');
  }
  return {
    record: assertRecordDetail(value.record),
    ...(value.tagPluginWarning === undefined ? {} : { tagPluginWarning: value.tagPluginWarning })
  };
};

export const assertFeedbackConfig = (value: unknown): FeedbackConfig => {
  if (!isRecord(value) || !isRecord(value.properties)) {
    throw new ValidationError('Invalid feedback configuration response.');
  }
  const assignedMappings = new Set<string>();
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([path, entry]) => {
      if (!isRecord(entry) || !isString(entry.path) || !isString(entry.target) || !isString(entry.tab)) {
        throw new ValidationError('Invalid feedback configuration entry.');
      }
      if (entry.path !== path || !FEEDBACK_MODES.includes(entry.feedback as FeedbackConfig['properties'][string]['feedback'])) {
        throw new ValidationError('Invalid feedback mode.');
      }
      if (typeof entry.comments !== 'boolean') {
        throw new ValidationError('Invalid feedback configuration flags.');
      }
      if (entry.editMode !== undefined && (!isString(entry.editMode) || !FEEDBACK_EDIT_MODES.includes(entry.editMode as NonNullable<FeedbackConfig['properties'][string]['editMode']>))) {
        throw new ValidationError('Invalid feedback configuration flags.');
      }
      if (entry.presentation !== undefined && (!isString(entry.presentation) || !FIELD_PRESENTATIONS.includes(entry.presentation as NonNullable<FeedbackConfig['properties'][string]['presentation']>))) {
        throw new ValidationError('Invalid field presentation.');
      }
      if (entry.mapping !== undefined) {
        if (!isString(entry.mapping) || !CANONICAL_MAPPINGS.includes(entry.mapping as NonNullable<FeedbackConfig['properties'][string]['mapping']>) || assignedMappings.has(entry.mapping)) {
          throw new ValidationError('Invalid canonical mapping.');
        }
        assignedMappings.add(entry.mapping);
      }
      return [
        path,
        {
          path,
          target: entry.target,
          tab: entry.tab,
          feedback: entry.feedback,
          comments: entry.comments,
          ...(entry.presentation === undefined ? {} : { presentation: entry.presentation }),
          ...(entry.mapping === undefined ? {} : { mapping: entry.mapping }),
          ...(entry.editMode === undefined ? {} : { editMode: entry.editMode })
        }
      ];
    })
  );
  return { properties } as FeedbackConfig;
};

const assertThemeTokens = (value: unknown): ThemeTokens => {
  if (!isRecord(value)) {
    throw new ValidationError('Invalid theme tokens.');
  }
  for (const key of REQUIRED_THEME_TOKEN_KEYS) {
    if (!isString(value[key]) || value[key].trim() === '') {
      throw new ValidationError(`Theme token ${key} must be a non-empty string.`);
    }
  }
  if (value.fontSerif !== undefined && (!isString(value.fontSerif) || value.fontSerif.trim() === '')) {
    throw new ValidationError('Theme token fontSerif must be a non-empty string when provided.');
  }
  const tokens = value as Record<(typeof REQUIRED_THEME_TOKEN_KEYS)[number], string> & { fontSerif?: string };
  return {
    bg: tokens.bg,
    bg2: tokens.bg2,
    surface: tokens.surface,
    surface2: tokens.surface2,
    border: tokens.border,
    text: tokens.text,
    textDim: tokens.textDim,
    accent: tokens.accent,
    accent2: tokens.accent2,
    success: tokens.success,
    warning: tokens.warning,
    danger: tokens.danger,
    focusRing: tokens.focusRing,
    fontSans: tokens.fontSans,
    ...(tokens.fontSerif === undefined ? {} : { fontSerif: tokens.fontSerif })
  };
};

export const assertTheme = (value: unknown): Theme => {
  if (!isRecord(value) || !isString(value.name) || value.name.trim() === '' || typeof value.builtIn !== 'boolean') {
    throw new ValidationError('Invalid theme.');
  }
  return {
    id: assertThemeId(value.id),
    name: value.name,
    builtIn: value.builtIn,
    tokens: assertThemeTokens(value.tokens)
  };
};

export const assertThemeState = (value: unknown): ThemeState => {
  if (!isRecord(value) || !Array.isArray(value.themes)) {
    throw new ValidationError('Invalid theme state.');
  }
  const themes = value.themes.map(assertTheme);
  const ids = new Set<string>();
  for (const theme of themes) {
    if (ids.has(theme.id)) {
      throw new ValidationError('Theme identifiers must be unique.');
    }
    ids.add(theme.id);
  }
  const activeThemeId = assertThemeId(value.activeThemeId);
  if (!ids.has(activeThemeId)) {
    throw new ValidationError('Active theme identifier must reference an available theme.');
  }
  return { activeThemeId, themes };
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
  if (value.configError !== undefined && !isString(value.configError)) {
    throw new ValidationError('Invalid bootstrap response.');
  }
  if (value.backendKind !== undefined && value.backendKind !== 'local' && value.backendKind !== 'azure-connection-string' && value.backendKind !== 'azure-default-credential') {
    throw new ValidationError('Invalid bootstrap response.');
  }
  return {
    ...(value.configError === undefined ? {} : { configError: value.configError }),
    ...(value.backendKind === undefined ? {} : { backendKind: value.backendKind }),
    projects: assertProjectSummaries(value.projects),
    themeState: assertThemeState(value.themeState),
    version: value.version
  };
};

export const assertAgentError = (value: unknown): AgentErrorEnvelope => {
  if (!isRecord(value) || !isString(value.code) || !isString(value.message) || typeof value.retryable !== 'boolean') {
    throw new ValidationError('Invalid agent error response.');
  }
  return value as AgentErrorEnvelope;
};

const assertAgentSettings = (value: unknown): AgentSettings => {
  if (!isRecord(value)) {
    throw new ValidationError('Invalid agent settings response.');
  }
  if (value.model !== undefined && !isString(value.model)) {
    throw new ValidationError('Invalid agent model setting.');
  }
  if (
    value.reasoningEffort !== undefined &&
    value.reasoningEffort !== 'low' &&
    value.reasoningEffort !== 'medium' &&
    value.reasoningEffort !== 'high' &&
    value.reasoningEffort !== 'xhigh'
  ) {
    throw new ValidationError('Invalid agent reasoning effort setting.');
  }
  return value as AgentSettings;
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
  if (value.settings !== undefined) {
    assertAgentSettings(value.settings);
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
