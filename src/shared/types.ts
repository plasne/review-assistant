export type BackendKind = 'local' | 'azure-connection-string' | 'azure-default-credential';

export type AppConfig = {
  backendKind: BackendKind;
  values: Record<string, string>;
  appEnvPath: string;
};

export type ExternalMcpServerConfig = {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout?: number;
  allowedTools?: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
};

export type RecordSummary = {
  id: string;
  displayName: string;
};

export type ValidationIssue = {
  path: string;
  message: string;
  keyword: string;
};

export type FieldPresentation = 'chat-request' | 'chat-response' | 'evidence-list' | 'diff-view';

export type DisplayConfigEntry = {
  path: string;
  presentation: FieldPresentation;
};

export type DisplayConfig = {
  properties: Record<string, DisplayConfigEntry>;
};

export type RenderNode =
  | {
      kind: 'object';
      label: string;
      path?: string;
      description?: string;
      presentation?: FieldPresentation;
      children: RenderNode[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'array';
      label: string;
      path?: string;
      description?: string;
      presentation?: FieldPresentation;
      items: RenderNode[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'value';
      label: string;
      path?: string;
      description?: string;
      presentation?: FieldPresentation;
      value: unknown;
      type?: string;
      enumValues?: unknown[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'raw';
      label: string;
      path?: string;
      description?: string;
      presentation?: FieldPresentation;
      value: unknown;
      reason: string;
      validationIssues: ValidationIssue[];
    };

export type OpenProjectResult = {
  project: ProjectSummary;
  schema: unknown;
  records: RecordSummary[];
  projectConfig: Record<string, string>;
  feedbackConfig?: FeedbackConfig;
};

export type RecordDetail = {
  projectId: string;
  recordId: string;
  displayName: string;
  data: unknown;
  schema: unknown;
  validationIssues: ValidationIssue[];
  renderTree: RenderNode;
  feedbackHistory?: Record<string, FeedbackHistory>;
};

export type RecordDraftStatus = {
  hasUnsavedChanges: boolean;
};

export type FeedbackMode = 'none' | 'good_fair_bad' | 'thumbs' | 'stars_5';
export type FeedbackEditMode = 'none' | 'logged' | 'inline';

export type FeedbackTarget = {
  path: string;
  target: string;
  tab: string;
  supportsEdit: boolean;
};

export type FeedbackConfigEntry = FeedbackTarget & {
  feedback: FeedbackMode;
  comments: boolean;
  editMode: FeedbackEditMode;
};

export type FeedbackConfig = {
  properties: Record<string, FeedbackConfigEntry>;
};

export type ProjectUser = {
  username?: string;
  valid: boolean;
  validationMessage?: string;
};

export type FeedbackEntry = {
  value: string;
  username: string;
  timestamp: string;
};

export type FeedbackHistory = {
  feedback: FeedbackEntry[];
  edits: FeedbackEntry[];
  comments: FeedbackEntry[];
  original?: string;
};

export type FeedbackSubmissionInput = {
  propertyPath: string;
  feedbackValue?: string;
  commentValue?: string;
  editValue?: string;
};

export type FeedbackSubmissionResult = {
  username: string;
  record: RecordDetail;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

export type AgentProviderMetadata = {
  id: 'github-copilot';
  name: string;
};

export type AgentErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'BINARY_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'REQUEST_CANCELED'
  | 'CONTEXT_TOO_LARGE'
  | 'TOOL_NOT_FOUND'
  | 'INVALID_TOOL_ARGUMENTS'
  | 'NO_RECORD_SELECTED'
  | 'RECORD_NOT_FOUND'
  | 'PROVIDER_ERROR';

export type AgentErrorEnvelope = {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string;
};

export type AgentAvailability = 'ready' | 'unavailable';

export type AgentStatusSnapshot = {
  provider: AgentProviderMetadata;
  availability: AgentAvailability;
  error?: AgentErrorEnvelope;
};

export type ChatStreamStartResult = {
  requestId: string;
  messageId: string;
};

export type ChatStreamChunk = {
  requestId: string;
  messageId: string;
  content: string;
};

export type ChatStreamComplete = {
  requestId: string;
  messageId: string;
};

export type ChatStreamError = {
  requestId: string;
  messageId?: string;
  error: AgentErrorEnvelope;
};

export type ChatCancelResult = {
  requestId: string;
  canceled: boolean;
};

export type ContinueWithGitHubResult = {
  copiedToClipboard?: boolean;
  deviceCode?: string;
  loginId: string;
  opened: boolean;
  verificationUri?: string;
};

export type GitHubLoginCompletion = {
  errorMessage?: string;
  loginId: string;
  success: boolean;
};

export type ChatCanceled = {
  requestId: string;
  messageId?: string;
};

export type ToolInvocationRequest = {
  tool: string;
  requestId: string;
  arguments: Record<string, unknown>;
};

export type LocalToolMetadata = {
  name: string;
  description: string;
  source: 'built-in' | 'plugin';
  pluginId?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolInvocationResponse =
  | {
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      ok: false;
      error: AgentErrorEnvelope;
    };

export type Unsubscribe = () => void;

export type ChatStreamEventHandlers = {
  onChatChunk: (listener: (chunk: ChatStreamChunk) => void) => Unsubscribe;
  onChatComplete: (listener: (complete: ChatStreamComplete) => void) => Unsubscribe;
  onChatError: (listener: (error: ChatStreamError) => void) => Unsubscribe;
  onChatCanceled: (listener: (canceled: ChatCanceled) => void) => Unsubscribe;
};

export type AuthEventHandlers = {
  onGitHubLoginComplete: (listener: (completion: GitHubLoginCompletion) => void) => Unsubscribe;
};

export type AppEventHandlers = {
  onCloseRequested: (listener: () => void) => Unsubscribe;
};

export type AppBootstrap = {
  configError?: string;
  backendKind?: BackendKind;
  projects: ProjectSummary[];
  version: string;
  autoOpenFirst?: boolean;
};

export type Api = {
  getBootstrap: () => Promise<AppBootstrap>;
  listProjects: () => Promise<ProjectSummary[]>;
  createProject: (projectId: string) => Promise<ProjectSummary>;
  openProject: (projectId: string) => Promise<OpenProjectResult>;
  getRecord: (projectId: string, recordId: string) => Promise<RecordDetail>;
  getRecordDraftStatus: (projectId: string, recordId: string) => Promise<RecordDraftStatus>;
  saveRecordChanges: (projectId: string, recordId: string) => Promise<RecordDetail>;
  discardRecordChanges: (projectId: string, recordId: string) => Promise<RecordDraftStatus>;
  getFeedbackConfig: (projectId: string) => Promise<FeedbackConfig>;
  saveFeedbackConfig: (projectId: string, config: FeedbackConfig) => Promise<FeedbackConfig>;
  getProjectUser: (projectId: string) => Promise<ProjectUser>;
  submitFeedback: (projectId: string, recordId: string, input: FeedbackSubmissionInput) => Promise<FeedbackSubmissionResult>;
  getAgentStatus: () => Promise<AgentStatusSnapshot>;
  startChat: (
    projectId: string | undefined,
    recordId: string | undefined,
    message: string,
    history?: ChatMessage[]
  ) => Promise<ChatStreamStartResult>;
  continueWithGitHub: () => Promise<ContinueWithGitHubResult>;
  closeWindow: () => Promise<void>;
  cancelChat: (requestId: string) => Promise<ChatCancelResult>;
} & AuthEventHandlers &
  AppEventHandlers &
  ChatStreamEventHandlers;
