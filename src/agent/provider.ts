import type {
  AgentErrorEnvelope,
  AgentProviderMetadata,
  AgentStatusSnapshot,
  ChatMessage,
  ExternalMcpServerConfig,
  LocalToolMetadata,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';

export type ChatContext = {
  message: string;
  history?: ChatMessage[];
  projectId?: string;
  recordId?: string;
  systemPrompt?: string;
  tools: LocalToolMetadata[];
  mcpServers?: ExternalMcpServerConfig[];
};

export type ProviderCallbacks = {
  chunk: (content: string) => void;
  complete: () => void;
  error: (error: AgentErrorEnvelope) => void;
  log: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

export type ProviderStartRequest = {
  requestId: string;
  messageId: string;
  context: ChatContext;
  prompt: string;
  startedAt: number;
  callbacks: ProviderCallbacks;
};

export type ActiveProviderRun = {
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type AgentProvider = {
  getStatus: (requestId: string) => Promise<AgentStatusSnapshot>;
  startChat: (request: ProviderStartRequest) => Promise<ActiveProviderRun>;
};

export type AgentProviderFactoryDeps = {
  providerMetadata: AgentProviderMetadata;
  requestTool: (chatRequestId: string, toolRequest: ToolInvocationRequest) => Promise<ToolInvocationResponse>;
  normalizeProviderError: (error: unknown) => AgentErrorEnvelope;
  sendLog: (level: 'info' | 'error', event: string, fields?: Record<string, unknown>) => void;
};
