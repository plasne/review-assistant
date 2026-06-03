import { pathToFileURL } from 'node:url';
import type {
  AgentErrorEnvelope,
  AgentStatusSnapshot,
  ChatMessage,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';
import type { ActiveProviderRun, AgentProvider, AgentProviderFactoryDeps, ChatContext } from './provider';

type WorkerRequest =
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

const MAX_PROMPT_CHARS = 120000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 40000;
const MAX_HISTORY_MESSAGE_CHARS = 8000;
const provider = { id: 'github-copilot' as const, name: 'GitHub Copilot' };
let active:
  | {
      requestId: string;
      messageId: string;
      run?: ActiveProviderRun;
      canceled: boolean;
      sawOutput: boolean;
      startedAt: number;
    }
  | undefined;
let agentProviderPromise: Promise<AgentProvider> | undefined;
const canceledRequests = new Set<string>();
const pendingToolRequests = new Map<string, (response: ToolInvocationResponse) => void>();

process.on('message', (message: WorkerRequest) => {
  if (message.type === 'toolResponse') {
    pendingToolRequests.get(message.toolRequestId)?.(message.response);
    pendingToolRequests.delete(message.toolRequestId);
    return;
  }
  if (message.type === 'status') {
    void checkStatus(message.requestId);
    return;
  }
  if (message.type === 'cancel') {
    cancelActive(message.requestId);
    return;
  }
  void startChat(message);
});

const startChat = async (request: Extract<WorkerRequest, { type: 'start' }>): Promise<void> => {
  const startedAt = Date.now();
  const prompt = buildPrompt(request.context);
  if (prompt.length > MAX_PROMPT_CHARS) {
    sendError(request.requestId, request.messageId, normalizeProviderError(new Error('Context too large for GitHub Copilot request.')));
    return;
  }

  active = { requestId: request.requestId, messageId: request.messageId, canceled: false, sawOutput: false, startedAt };
  sendLog('info', 'review-assistant.agent-worker-starting', {
    requestId: request.requestId,
    toolCount: request.context.tools.length,
    promptChars: prompt.length,
    mcpEnabled: request.context.tools.length > 0 || (request.context.mcpServers ?? []).length > 0,
    externalMcpServers: (request.context.mcpServers ?? []).map((server) => server.id).join(',') || 'none',
    setupMs: Date.now() - startedAt
  });

  try {
    const agentProvider = await getAgentProvider();
    const run = await agentProvider.startChat({
      requestId: request.requestId,
      messageId: request.messageId,
      context: request.context,
      prompt,
      startedAt,
      callbacks: {
        chunk: (content) => {
          if (!content || active?.requestId !== request.requestId || active.canceled) {
            return;
          }
          if (!active.sawOutput) {
            sendLog('info', 'review-assistant.agent-first-output', { requestId: request.requestId, elapsedMs: Date.now() - startedAt });
          }
          active.sawOutput = true;
          process.send?.({ type: 'chunk', requestId: request.requestId, messageId: request.messageId, content });
        },
        complete: () => {
          if (active?.requestId !== request.requestId || active.canceled) {
            return;
          }
          if (!active.sawOutput) {
            process.send?.({ type: 'chunk', requestId: request.requestId, messageId: request.messageId, content: '' });
          }
          process.send?.({ type: 'complete', requestId: request.requestId, messageId: request.messageId });
          sendLog('info', 'review-assistant.agent-worker-completed', {
            requestId: request.requestId,
            code: 0,
            signal: 'none',
            elapsedMs: Date.now() - startedAt
          });
          void finish(request.requestId);
        },
        error: (error) => {
          if (active?.requestId !== request.requestId || active.canceled) {
            return;
          }
          sendError(request.requestId, request.messageId, error);
          void finish(request.requestId);
        },
        log: sendLog
      }
    });
    if (active?.requestId !== request.requestId) {
      await run.dispose();
      return;
    }
    active.run = run;
    if (canceledRequests.delete(request.requestId) || active.canceled) {
      cancelActive(request.requestId);
    }
  } catch (error) {
    if (active?.requestId === request.requestId && active.canceled) {
      process.send?.({ type: 'canceled', requestId: request.requestId, messageId: request.messageId });
    } else {
      sendError(request.requestId, request.messageId, normalizeProviderError(error));
    }
    await finish(request.requestId);
  }
};

const checkStatus = async (requestId: string): Promise<void> => {
  try {
    const agentProvider = await getAgentProvider();
    const status = await agentProvider.getStatus(requestId);
    process.send?.({ type: 'status', requestId, ...status });
  } catch (error) {
    process.send?.(unavailable(requestId, normalizeProviderError(error)));
  }
};

const cancelActive = (requestId: string): void => {
  if (!active || active.requestId !== requestId) {
    canceledRequests.add(requestId);
    return;
  }
  active.canceled = true;
  const cancel = active.run?.cancel() ?? Promise.resolve();
  void cancel
    .catch((error: unknown) => {
      sendLog('error', 'review-assistant.agent-provider-cancel-failed', {
        requestId,
        message: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      if (active?.requestId !== requestId) {
        return;
      }
      sendLog('info', 'review-assistant.agent-provider-canceled', {
        requestId,
        code: 'none',
        signal: 'none',
        elapsedMs: Date.now() - active.startedAt
      });
      process.send?.({ type: 'canceled', requestId, messageId: active.messageId });
      void finish(requestId);
    });
};

const finish = async (requestId: string): Promise<void> => {
  if (!active || active.requestId !== requestId) {
    return;
  }
  const run = active.run;
  active = undefined;
  await run?.dispose();
};

const buildPrompt = (context: ChatContext): string => {
  const parts = [
    context.systemPrompt ? `System prompt:\n${context.systemPrompt}` : 'System prompt: none',
    context.projectId
      ? `Selected project: ${context.projectId}`
      : 'Selected project: none. No project prompt, selected record, or project-scoped tools are available for this request.',
    context.recordId ? `Selected record: ${context.recordId}` : 'Selected record: none',
    `Review Assistant tools:\n${JSON.stringify(
      context.tools.map(({ name, description, source, pluginId }) => ({
        name,
        description,
        source,
        pluginId
      })),
      null,
      2
    )}`,
    `External MCP servers:\n${JSON.stringify(
      (context.mcpServers ?? []).map(({ id, allowedTools }) => ({
        id,
        allowedTools: allowedTools ?? 'all'
      })),
      null,
      2
    )}`,
    `Conversation so far:\n${formatHistory(context.history ?? [])}`,
    `User message:\n${context.message}`
  ];
  return parts.join('\n\n');
};

const formatHistory = (history: ChatMessage[]): string => {
  const eligible = history.filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim() !== '');
  const recent = eligible.slice(-MAX_HISTORY_MESSAGES);
  const selected: ChatMessage[] = [];
  let remaining = MAX_HISTORY_CHARS;
  for (const message of recent.slice().reverse()) {
    const content = truncateText(message.content.trim(), MAX_HISTORY_MESSAGE_CHARS);
    const chars = content.length;
    if (chars > remaining && selected.length > 0) {
      break;
    }
    selected.push({ ...message, content: truncateText(content, remaining) });
    remaining -= Math.min(chars, remaining);
    if (remaining <= 0) {
      break;
    }
  }
  if (selected.length === 0) {
    return 'none';
  }
  return selected
    .reverse()
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n');
};

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 12) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 12)}\n[truncated]`;
};

const getAgentProvider = async (): Promise<AgentProvider> => {
  agentProviderPromise ??= loadAgentProvider();
  return await agentProviderPromise;
};

const loadAgentProvider = async (): Promise<AgentProvider> => {
  const deps: AgentProviderFactoryDeps = {
    providerMetadata: provider,
    requestTool,
    normalizeProviderError,
    sendLog
  };
  const providerModule = process.env.REVIEW_ASSISTANT_AGENT_PROVIDER_MODULE;
  if (providerModule) {
    const imported = (await import(pathToFileURL(providerModule).href)) as {
      createAgentProvider?: (deps: AgentProviderFactoryDeps) => AgentProvider;
    };
    if (!imported.createAgentProvider) {
      throw new Error(`Agent provider module does not export createAgentProvider: ${providerModule}`);
    }
    return imported.createAgentProvider(deps);
  }
  const { createCopilotSdkProvider } = await import('./copilot-sdk-provider');
  return createCopilotSdkProvider(deps);
};

const requestTool = async (chatRequestId: string, toolRequest: ToolInvocationRequest): Promise<ToolInvocationResponse> =>
  await new Promise<ToolInvocationResponse>((resolve) => {
    const startedAt = Date.now();
    sendLog('info', 'review-assistant.tool-request-started', { requestId: chatRequestId, tool: toolRequest.tool, toolRequestId: toolRequest.requestId });
    const timeout = setTimeout(() => {
      pendingToolRequests.delete(toolRequest.requestId);
      sendLog('error', 'review-assistant.tool-request-timeout', {
        requestId: chatRequestId,
        tool: toolRequest.tool,
        toolRequestId: toolRequest.requestId,
        elapsedMs: Date.now() - startedAt
      });
      resolve({
        requestId: toolRequest.requestId,
        ok: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: `Tool request timed out: ${toolRequest.tool}`,
          retryable: true
        }
      });
    }, 30000);
    pendingToolRequests.set(toolRequest.requestId, (response) => {
      clearTimeout(timeout);
      sendLog('info', 'review-assistant.tool-request-completed', {
        requestId: chatRequestId,
        tool: toolRequest.tool,
        toolRequestId: toolRequest.requestId,
        ok: response.ok,
        code: response.ok ? undefined : response.error.code,
        elapsedMs: Date.now() - startedAt
      });
      resolve(response);
    });
    process.send?.({ type: 'toolRequest', requestId: chatRequestId, toolRequest });
  });

const sendLog = (level: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void => {
  process.send?.({ type: 'log', level, event, fields });
};

const sendError = (requestId: string, messageId: string | undefined, error: AgentErrorEnvelope): void => {
  process.send?.({ type: 'error', requestId, messageId, error });
};

const unavailable = (requestId: string, error: AgentErrorEnvelope): AgentStatusSnapshot & { type: 'status'; requestId: string } => ({
  type: 'status',
  requestId,
  provider,
  availability: 'unavailable',
  error
});

const normalizeProviderError = (error: unknown): AgentErrorEnvelope => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('enoent') || normalized.includes('not found') || normalized.includes('cannot find module') || normalized.includes('no such file')) {
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
  if (normalized.includes('cancel') || normalized.includes('abort')) {
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
