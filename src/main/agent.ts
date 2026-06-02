import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { logError, logInfo } from '../shared/logging';
import type {
  AgentErrorEnvelope,
  AgentProviderMetadata,
  AgentStatusSnapshot,
  ChatCanceled,
  ChatStreamChunk,
  ChatStreamComplete,
  ChatStreamError,
  ChatStreamStartResult,
  ExternalMcpServerConfig,
  LocalToolMetadata,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';
import type { LocalToolRuntime } from './tools';

export type ChatContext = {
  message: string;
  projectId?: string;
  recordId?: string;
  projectPrompt?: string;
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

export type ChatStreamHandlers = {
  chunk: (chunk: ChatStreamChunk) => void;
  complete: (complete: ChatStreamComplete) => void;
  error: (error: ChatStreamError) => void;
  canceled: (canceled: ChatCanceled) => void;
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
};

const provider: AgentProviderMetadata = {
  id: 'github-copilot',
  name: 'GitHub Copilot'
};

export class AgentRuntime {
  private readonly pending = new Map<string, PendingChat>();

  constructor(private readonly options: AgentRuntimeOptions) {}

  async getStatus(timeoutMs = 5000): Promise<AgentStatusSnapshot> {
    const requestId = randomUUID();
    const child = this.forkWorker();
    return await new Promise<AgentStatusSnapshot>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve(unavailable(normalizeProviderError(new Error('Timed out while checking GitHub Copilot availability.'))));
      }, timeoutMs);
      child.once('message', (event: ProviderWorkerEvent) => {
        clearTimeout(timeout);
        child.kill();
        if (event.type === 'status' && event.requestId === requestId) {
          resolve(event);
          return;
        }
        resolve(unavailable(normalizeProviderError(new Error('Invalid GitHub Copilot status response.'))));
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        resolve(unavailable(normalizeProviderError(error)));
      });
      child.send({ type: 'status', requestId } satisfies ProviderWorkerRequest);
    });
  }

  async start(context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    const startedAt = Date.now();
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
      projectId: context.projectId ?? 'none',
      recordId: context.recordId ?? 'none',
      toolCount: context.tools.length,
      tools: context.tools.map((tool) => tool.name).join(',') || 'none',
      externalMcpServers: context.mcpServers?.map((server) => server.id).join(',') || 'none',
      statusCheckMs: Date.now() - startedAt
    });
    setImmediate(() => child.send({ type: 'start', requestId, messageId, context } satisfies ProviderWorkerRequest));
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
    return fork(this.options.workerPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...this.options.commandEnv,
        REVIEW_ASSISTANT_COPILOT_COMMAND: this.options.command ?? process.env.REVIEW_ASSISTANT_COPILOT_COMMAND ?? 'copilot',
        REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS:
          this.options.commandArgs?.join('\n') ?? process.env.REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS ?? ''
      }
    });
  }

  private handleWorkerEvent(requestId: string, event: ProviderWorkerEvent): void {
    if (event.type === 'log') {
      const logger = event.level === 'error' ? logError : logInfo;
      logger(event.event, event.fields);
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
      elapsedMs: Date.now() - startedAt
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

export class AgentRuntimeError extends Error {
  constructor(readonly envelope: AgentErrorEnvelope) {
    super(envelope.message);
    this.name = 'AgentRuntimeError';
  }
}

export const normalizeProviderError = (error: unknown): AgentErrorEnvelope => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('enoent') || normalized.includes('not found')) {
    return {
      code: 'BINARY_NOT_FOUND',
      message: 'GitHub Copilot CLI was not found.',
      retryable: true,
      remediation: 'Install GitHub Copilot CLI or run `gh copilot` once to provision it, then check agent status again.'
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

const unavailable = (error: AgentErrorEnvelope): AgentStatusSnapshot => ({
  provider,
  availability: 'unavailable',
  error
});
