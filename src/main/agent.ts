import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { logError, logInfo } from '../shared/logging';
import type {
  AgentErrorEnvelope,
  AgentProviderMetadata,
  AgentSettings,
  AgentStatusSnapshot,
  ChatCanceled,
  ChatAttachmentContent,
  ChatMessage,
  ChatStreamChunk,
  ChatStreamComplete,
  ChatStreamError,
  ChatStreamStartResult,
  ExternalMcpServerConfig,
  LocalToolMetadata,
  CopilotRuntimeSettings,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';
import type { LocalToolRuntime } from './tools';
import { DEFAULT_COPILOT_STATUS_TIMEOUT_MS } from './env';

export type ChatContext = {
  message: string;
  history?: ChatMessage[];
  attachments?: ChatAttachmentContent[];
  projectId?: string;
  recordId?: string;
  systemPrompt?: string;
  agentSettings?: AgentSettings;
  tools: LocalToolMetadata[];
  mcpServers?: ExternalMcpServerConfig[];
};

type ProviderWorkerRequest =
  | {
      type: 'start';
      requestId: string;
      messageId: string;
      context: ChatContext;
    }
  | {
      type: 'cancel';
      requestId: string;
    }
  | {
      type: 'status';
      requestId: string;
    }
  | {
      type: 'toolResponse';
      requestId: string;
      toolRequestId: string;
      response: ToolInvocationResponse;
    };

type ProviderWorkerEvent =
  | ({ type: 'chunk' } & ChatStreamChunk)
  | ({ type: 'complete' } & ChatStreamComplete)
  | ({ type: 'error' } & ChatStreamError)
  | ({ type: 'canceled' } & ChatCanceled)
  | ({ type: 'status' } & AgentStatusSnapshot & { requestId: string })
  | { type: 'log'; level: 'info' | 'error'; event: string; fields: Record<string, unknown> }
  | ({ type: 'toolRequest'; requestId: string; toolRequest: ToolInvocationRequest });

export type ChatLogEvent = {
  level: 'info' | 'error';
  event: string;
  fields: Record<string, unknown>;
};

const MAX_WORKER_STDERR_CHARS = 4000;

export type ChatStreamHandlers = {
  chunk: (chunk: ChatStreamChunk) => void;
  complete: (complete: ChatStreamComplete) => void;
  error: (error: ChatStreamError) => void;
  canceled: (canceled: ChatCanceled) => void;
  log?: (event: ChatLogEvent) => void;
};

type PendingChat = {
  child: ChildProcess;
  messageId: string;
  handlers: ChatStreamHandlers;
  tools: LocalToolRuntime;
  startedAt: number;
};

type AgentRuntimeOptions = {
  workerPath: string;
  command?: string;
  commandArgs?: string[];
  commandEnv?: NodeJS.ProcessEnv;
  providerModule?: string;
  agentSettings?: AgentSettings;
  copilotRuntimeSettings?: CopilotRuntimeSettings;
  statusTimeoutMs?: number;
};

const provider: AgentProviderMetadata = {
  id: 'github-copilot',
  name: 'GitHub Copilot'
};

export class AgentRuntime {
  private readonly pending = new Map<string, PendingChat>();
  private agentSettings: AgentSettings;
  private copilotRuntimeSettings: CopilotRuntimeSettings;
  private statusTimeoutMs: number;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.agentSettings = options.agentSettings ?? {};
    this.copilotRuntimeSettings = options.copilotRuntimeSettings ?? legacyCopilotRuntimeSettings(options);
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_COPILOT_STATUS_TIMEOUT_MS;
  }

  setAgentSettings(agentSettings: AgentSettings): void {
    this.agentSettings = agentSettings;
  }

  getAgentSettings(): AgentSettings {
    return this.agentSettings;
  }

  setCopilotRuntimeSettings(copilotRuntimeSettings: CopilotRuntimeSettings): void {
    this.copilotRuntimeSettings = copilotRuntimeSettings;
  }

  getCopilotRuntimeSettings(): CopilotRuntimeSettings {
    return this.copilotRuntimeSettings;
  }

  setStatusTimeoutMs(timeoutMs: number): void {
    this.statusTimeoutMs = timeoutMs;
  }

  getStatusTimeoutMs(): number {
    return this.statusTimeoutMs;
  }

  async getStatus(timeoutMs = this.statusTimeoutMs): Promise<AgentStatusSnapshot> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const child = this.forkWorker();
    return await new Promise<AgentStatusSnapshot>((resolve) => {
      let settled = false;
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string | Buffer) => {
        stderr = trimWorkerStderr(`${stderr}${String(chunk)}`);
      });
      const finish = (status: AgentStatusSnapshot): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.off('message', handleMessage);
        child.off('error', handleError);
        child.off('exit', handleExit);
        child.kill();
        resolve(status);
      };
      const handleMessage = (event: ProviderWorkerEvent): void => {
        if (event.type === 'log') {
          const logger = event.level === 'error' ? logError : logInfo;
          logger(event.event, event.fields);
          return;
        }
        if (event.type === 'status' && event.requestId === requestId) {
          logInfo('review-assistant.agent-status-completed', {
            provider: provider.id,
            requestId,
            availability: event.availability,
            code: event.error?.code,
            elapsedMs: Date.now() - startedAt
          });
          finish(event);
          return;
        }
        finish(unavailable(normalizeProviderError(new Error('Invalid GitHub Copilot status response.')), this.agentSettings));
      };
      const handleError = (error: Error): void => {
        logError('review-assistant.agent-status-failed', {
          provider: provider.id,
          requestId,
          message: error.message,
          elapsedMs: Date.now() - startedAt
        });
        finish(unavailable(normalizeProviderError(error), this.agentSettings));
      };
      const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled || signal === 'SIGTERM') {
          return;
        }
        const diagnostic = normalizeWorkerDiagnostic(stderr);
        const message = diagnostic
          ? `GitHub Copilot status worker failed before reporting availability: ${diagnostic}`
          : code === null
            ? `GitHub Copilot status worker exited before reporting availability with signal ${signal ?? 'unknown'}.`
            : `GitHub Copilot status worker exited before reporting availability with code ${code}.`;
        logError('review-assistant.agent-status-worker-exited', {
          provider: provider.id,
          requestId,
          code,
          signal,
          stderr: diagnostic,
          elapsedMs: Date.now() - startedAt
        });
        finish(unavailable(normalizeProviderError(new Error(message)), this.agentSettings));
      };
      const timeout = setTimeout(() => {
        const error = createStatusTimeoutError(timeoutMs);
        logError('review-assistant.agent-status-timeout', {
          provider: provider.id,
          requestId,
          timeoutMs,
          elapsedMs: Date.now() - startedAt
        });
        finish(unavailable(error, this.agentSettings));
      }, timeoutMs);
      logInfo('review-assistant.agent-status-started', { provider: provider.id, requestId, timeoutMs });
      child.on('message', handleMessage);
      child.once('error', handleError);
      child.once('exit', handleExit);
      child.send({ type: 'status', requestId } satisfies ProviderWorkerRequest);
    });
  }

  async start(context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    const startedAt = Date.now();
    const contextWithSettings = { ...context, agentSettings: context.agentSettings ?? this.agentSettings };
    const status = await this.getStatus();
    if (status.availability === 'unavailable') {
      throw new AgentRuntimeError(status.error ?? normalizeProviderError(new Error('GitHub Copilot is unavailable.')));
    }

    const requestId = randomUUID();
    const messageId = randomUUID();
    const child = this.forkWorker();
    this.pending.set(requestId, { child, messageId, handlers, tools, startedAt });
    child.on('message', (event: ProviderWorkerEvent) => this.handleWorkerEvent(requestId, event));
    child.once('error', (error) => {
      this.finishWithError(requestId, normalizeProviderError(error));
    });
    child.once('exit', (_code, signal) => {
      if (this.pending.has(requestId) && signal !== 'SIGTERM') {
        this.finishWithError(requestId, normalizeProviderError(new Error('GitHub Copilot worker exited before completing the response.')));
      }
    });
    logInfo('review-assistant.agent-request-started', {
      provider: provider.id,
      requestId,
      projectId: contextWithSettings.projectId ?? 'none',
      recordId: contextWithSettings.recordId ?? 'none',
      attachmentCount: contextWithSettings.attachments?.length ?? 0,
      attachmentChars: contextWithSettings.attachments?.reduce((total, attachment) => total + attachment.content.length, 0) ?? 0,
      toolCount: contextWithSettings.tools.length,
      tools: contextWithSettings.tools.map((tool) => tool.name).join(',') || 'none',
      externalMcpServers: contextWithSettings.mcpServers?.map((server) => server.id).join(',') || 'none',
      statusCheckMs: Date.now() - startedAt
    });
    setImmediate(() => child.send({ type: 'start', requestId, messageId, context: contextWithSettings } satisfies ProviderWorkerRequest));
    return { requestId, messageId };
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    pending.child.send({ type: 'cancel', requestId } satisfies ProviderWorkerRequest);
    setTimeout(() => {
      if (this.pending.has(requestId)) {
        pending.child.kill();
        this.pending.delete(requestId);
      }
    }, 2000).unref();
    return true;
  }

  cancelAll(): void {
    for (const requestId of this.pending.keys()) {
      this.cancel(requestId);
    }
  }

  private forkWorker(): ChildProcess {
    const providerModule = this.options.providerModule ?? process.env.AGENT_PROVIDER_MODULE;
    const agentSettings = JSON.stringify(this.agentSettings);
    return fork(this.options.workerPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...withoutCopilotRuntimeEnv(process.env),
        ...withoutCopilotRuntimeEnv(this.options.commandEnv ?? {}),
        ...toCopilotRuntimeEnv(this.copilotRuntimeSettings),
        ...(providerModule ? { AGENT_PROVIDER_MODULE: providerModule } : {}),
        AGENT_SETTINGS: agentSettings
      }
    });
  }

  private handleWorkerEvent(requestId: string, event: ProviderWorkerEvent): void {
    if (event.type === 'log') {
      const logger = event.level === 'error' ? logError : logInfo;
      logger(event.event, event.fields);
      this.pending.get(requestId)?.handlers.log?.({ level: event.level, event: event.event, fields: event.fields });
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || event.requestId !== requestId) {
      return;
    }
    if (event.type === 'chunk') {
      pending.handlers.chunk({ requestId, messageId: event.messageId, content: event.content });
      return;
    }
    if (event.type === 'complete') {
      pending.handlers.complete({ requestId, messageId: event.messageId });
      this.cleanup(requestId);
      logInfo('review-assistant.agent-request-completed', { provider: provider.id, requestId, elapsedMs: Date.now() - pending.startedAt });
      return;
    }
    if (event.type === 'canceled') {
      pending.handlers.canceled({ requestId, messageId: event.messageId });
      this.cleanup(requestId);
      logInfo('review-assistant.agent-request-canceled', { provider: provider.id, requestId, elapsedMs: Date.now() - pending.startedAt });
      return;
    }
    if (event.type === 'error') {
      pending.handlers.error({ requestId, messageId: event.messageId, error: event.error });
      this.cleanup(requestId);
      logError('review-assistant.agent-request-failed', {
        provider: provider.id,
        requestId,
        code: event.error.code,
        message: event.error.message,
        elapsedMs: Date.now() - pending.startedAt
      });
      return;
    }
    if (event.type === 'toolRequest') {
      void this.handleToolRequest(requestId, event.toolRequest);
    }
  }

  private async handleToolRequest(requestId: string, request: ToolInvocationRequest): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    let response: ToolInvocationResponse;
    const startedAt = Date.now();
    logInfo('review-assistant.tool-execute-started', { requestId, tool: request.tool, toolRequestId: request.requestId });
    try {
      response = await pending.tools.execute(request);
    } catch (error) {
      response = {
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        }
      };
    }
    logInfo('review-assistant.tool-execute-completed', {
      requestId,
      tool: request.tool,
      toolRequestId: request.requestId,
      ok: response.ok,
      code: response.ok ? undefined : response.error.code,
      elapsedMs: Date.now() - startedAt,
      ...localToolResultLogFields(response)
    });
    pending.child.send({
      type: 'toolResponse',
      requestId,
      toolRequestId: request.requestId,
      response
    } satisfies ProviderWorkerRequest);
  }

  private finishWithError(requestId: string, error: AgentErrorEnvelope): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    pending.handlers.error({ requestId, messageId: pending.messageId, error });
    this.cleanup(requestId);
  }

  private cleanup(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    pending.child.kill();
    this.pending.delete(requestId);
  }
}

const trimWorkerStderr = (value: string): string => value.length > MAX_WORKER_STDERR_CHARS ? value.slice(-MAX_WORKER_STDERR_CHARS) : value;

const normalizeWorkerDiagnostic = (stderr: string): string | undefined => {
  const normalized = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
};

export class AgentRuntimeError extends Error {
  constructor(readonly envelope: AgentErrorEnvelope) {
    super(envelope.message);
    this.name = 'AgentRuntimeError';
  }
}

export const localToolResultLogFields = (response: ToolInvocationResponse): Record<string, unknown> => {
  if (!response.ok || !isRecord(response.result)) {
    return {};
  }
  const result = response.result;
  return {
    targetPath: stringField(result.targetPath),
    containerPath: stringField(result.containerPath),
    responseField: stringField(result.responseField),
    evidenceField: stringField(result.evidenceField),
    evidenceContainerPath: stringField(result.evidenceContainerPath),
    savedEvidenceCount: numberField(result.savedEvidenceCount),
    savedItemCount: numberField(result.savedItemCount),
    containerItemCount: numberField(result.containerItemCount),
    turnIndex: numberField(result.turnIndex)
  };
};

const stringField = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const COPILOT_RUNTIME_ENV_KEYS = new Set(['COPILOT_RUNTIME_COMMAND', 'COPILOT_RUNTIME_ARGS', 'COPILOT_RUNTIME_TRANSPORT']);

const withoutCopilotRuntimeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !COPILOT_RUNTIME_ENV_KEYS.has(key)));

const toCopilotRuntimeEnv = (settings: CopilotRuntimeSettings): NodeJS.ProcessEnv => ({
  ...(settings.command ? { COPILOT_RUNTIME_COMMAND: settings.command } : {}),
  ...(settings.args && settings.args.length > 0 ? { COPILOT_RUNTIME_ARGS: settings.args.join('\n') } : {}),
  ...(settings.transport ? { COPILOT_RUNTIME_TRANSPORT: settings.transport } : {})
});

const legacyCopilotRuntimeSettings = (options: AgentRuntimeOptions): CopilotRuntimeSettings => ({
  ...(options.command ? { command: options.command } : {}),
  ...(options.commandArgs && options.commandArgs.length > 0 ? { args: options.commandArgs } : {})
});

export const normalizeProviderError = (error: unknown): AgentErrorEnvelope => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('enoent') || normalized.includes('not found')) {
    return {
      code: 'BINARY_NOT_FOUND',
      message: 'GitHub Copilot runtime was not found.',
      retryable: true,
      remediation: 'Install the Review Assistant dependencies or configure a valid GitHub Copilot SDK runtime, then check agent status again.'
    };
  }
  if (normalized.includes('auth') || normalized.includes('login') || normalized.includes('sign in') || normalized.includes('unauthorized')) {
    return {
      code: 'AUTH_REQUIRED',
      message: 'GitHub Copilot is not signed in or the current session is not authorized.',
      retryable: true,
      remediation: 'Run `copilot login` or sign in with GitHub Copilot through your local tooling, then check agent status again.'
    };
  }
  if (normalized.includes('context too large')) {
    return {
      code: 'CONTEXT_TOO_LARGE',
      message: 'The selected prompt and record are too large to send to GitHub Copilot.',
      retryable: false,
      remediation: 'Select a smaller record or shorten the project prompt.'
    };
  }
  if (normalized.includes('cancel')) {
    return {
      code: 'REQUEST_CANCELED',
      message: 'The GitHub Copilot response was canceled.',
      retryable: false
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    message: message || 'GitHub Copilot returned an unexpected error.',
    retryable: true,
    remediation: 'Check GitHub Copilot availability and try again.'
  };
};

const createStatusTimeoutError = (timeoutMs: number): AgentErrorEnvelope => ({
  code: 'STATUS_TIMEOUT',
  message: `GitHub Copilot status check did not finish within ${formatTimeoutDuration(timeoutMs)}.`,
  retryable: true,
  remediation:
    'The Copilot runtime may be stuck starting, pinging, or checking authentication. Review the application logs for review-assistant.copilot-status-step entries to find the last step that began without completing.'
});

const formatTimeoutDuration = (timeoutMs: number): string => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
};

const unavailable = (error: AgentErrorEnvelope, settings: AgentSettings = {}): AgentStatusSnapshot => ({
  provider,
  availability: 'unavailable',
  error,
  settings
});
