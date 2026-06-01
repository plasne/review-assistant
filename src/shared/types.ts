export type BackendKind = 'local' | 'azure-connection-string' | 'azure-default-credential';

export type AppConfig = {
  backendKind: BackendKind;
  values: Record<string, string>;
  appEnvPath: string;
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

export type RenderNode =
  | {
      kind: 'object';
      label: string;
      description?: string;
      children: RenderNode[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'array';
      label: string;
      description?: string;
      items: RenderNode[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'value';
      label: string;
      description?: string;
      value: unknown;
      type?: string;
      enumValues?: unknown[];
      validationIssues: ValidationIssue[];
    }
  | {
      kind: 'raw';
      label: string;
      description?: string;
      value: unknown;
      reason: string;
      validationIssues: ValidationIssue[];
    };

export type OpenProjectResult = {
  project: ProjectSummary;
  schema: unknown;
  records: RecordSummary[];
  projectConfig: Record<string, string>;
};

export type RecordDetail = {
  projectId: string;
  recordId: string;
  displayName: string;
  data: unknown;
  schema: unknown;
  validationIssues: ValidationIssue[];
  renderTree: RenderNode;
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

export type AppBootstrap = {
  configError?: string;
  backendKind?: BackendKind;
  projects: ProjectSummary[];
  version: string;
};

export type Api = {
  getBootstrap: () => Promise<AppBootstrap>;
  listProjects: () => Promise<ProjectSummary[]>;
  createProject: (projectId: string) => Promise<ProjectSummary>;
  openProject: (projectId: string) => Promise<OpenProjectResult>;
  getRecord: (projectId: string, recordId: string) => Promise<RecordDetail>;
  getAgentStatus: () => Promise<AgentStatusSnapshot>;
  startChat: (projectId: string | undefined, recordId: string | undefined, message: string) => Promise<ChatStreamStartResult>;
  cancelChat: (requestId: string) => Promise<ChatCancelResult>;
} & ChatStreamEventHandlers;
