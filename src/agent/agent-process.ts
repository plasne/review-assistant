import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentErrorEnvelope,
  AgentStatusSnapshot,
  ChatMessage,
  ExternalMcpServerConfig,
  LocalToolMetadata,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';

type ChatContext = {
  message: string;
  history?: ChatMessage[];
  projectId?: string;
  recordId?: string;
  systemPrompt?: string;
  tools: LocalToolMetadata[];
  mcpServers?: ExternalMcpServerConfig[];
};

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
const TOOL_SERVER_NAME = 'review_assistant';
const provider = { id: 'github-copilot' as const, name: 'GitHub Copilot' };
let active:
  | {
      requestId: string;
      messageId: string;
      child: ChildProcessWithoutNullStreams;
      tempDir: string;
      canceled: boolean;
      mcpConfig?: ActiveMcpConfig;
    }
  | undefined;
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-copilot-'));
  const mcpConfig = await createMcpConfig(request.requestId, tempDir, request.context.tools, request.context.mcpServers ?? []);
  const prompt = buildPrompt(request.context);
  if (prompt.length > MAX_PROMPT_CHARS) {
    sendError(request.requestId, request.messageId, normalizeProviderError(new Error('Context too large for GitHub Copilot request.')));
    await mcpConfig?.close();
    await cleanupTempDir(tempDir);
    return;
  }

  const { command, args } = getCopilotCommand(prompt, tempDir, mcpConfig);
  sendLog('info', 'review-assistant.agent-worker-starting', {
    requestId: request.requestId,
    toolCount: request.context.tools.length,
    promptChars: prompt.length,
    mcpEnabled: Boolean(mcpConfig),
    externalMcpServers: (request.context.mcpServers ?? []).map((server) => server.id).join(',') || 'none',
    setupMs: Date.now() - startedAt
  });
  const child = spawn(command, args, {
    cwd: tempDir,
    detached: true,
    env: {
      ...process.env,
      NO_COLOR: '1'
    }
  });
  sendLog('info', 'review-assistant.agent-provider-spawned', {
    requestId: request.requestId,
    pid: child.pid,
    command,
    argCount: args.length,
    elapsedMs: Date.now() - startedAt
  });
  active = { requestId: request.requestId, messageId: request.messageId, child, tempDir, canceled: false, mcpConfig };
  if (canceledRequests.delete(request.requestId)) {
    cancelActive(request.requestId);
  }
  const decoder = new StringDecoder('utf8');
  let stderr = '';
  let sawOutput = false;

  child.stdout.on('data', (chunk: Buffer) => {
    const content = decoder.write(chunk);
    if (!content || active?.requestId !== request.requestId) {
      return;
    }
    if (!sawOutput) {
      sendLog('info', 'review-assistant.agent-first-output', { requestId: request.requestId, elapsedMs: Date.now() - startedAt });
    }
    sawOutput = true;
    process.send?.({ type: 'chunk', requestId: request.requestId, messageId: request.messageId, content });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const content = chunk.toString('utf8');
    stderr += content;
    sendLog('info', 'review-assistant.agent-provider-stderr', {
      requestId: request.requestId,
      chars: content.length,
      sample: content.trim().slice(0, 300)
    });
  });
  child.once('error', async (error) => {
    sendLog('error', 'review-assistant.agent-provider-error', { requestId: request.requestId, message: error.message });
    sendError(request.requestId, request.messageId, normalizeProviderError(error));
    await finish(request.requestId);
  });
  child.once('close', async (code, signal) => {
    const remaining = decoder.end();
    if (remaining && active?.requestId === request.requestId) {
      sawOutput = true;
      process.send?.({ type: 'chunk', requestId: request.requestId, messageId: request.messageId, content: remaining });
    }
    if (active?.requestId !== request.requestId) {
      await cleanupTempDir(tempDir);
      return;
    }
    if (active.canceled || signal === 'SIGTERM') {
      sendLog('info', 'review-assistant.agent-provider-canceled', {
        requestId: request.requestId,
        code: code ?? 'none',
        signal: signal ?? 'none',
        elapsedMs: Date.now() - startedAt
      });
      process.send?.({ type: 'canceled', requestId: request.requestId, messageId: request.messageId });
      await finish(request.requestId);
      return;
    }
    if (code === 0) {
      if (!sawOutput) {
        process.send?.({ type: 'chunk', requestId: request.requestId, messageId: request.messageId, content: '' });
      }
      process.send?.({ type: 'complete', requestId: request.requestId, messageId: request.messageId });
      sendLog('info', 'review-assistant.agent-worker-completed', {
        requestId: request.requestId,
        code,
        signal: signal ?? 'none',
        elapsedMs: Date.now() - startedAt
      });
      await finish(request.requestId);
      return;
    }
    sendLog('error', 'review-assistant.agent-provider-failed', {
      requestId: request.requestId,
      code: code ?? 'none',
      signal: signal ?? 'none',
      stderrChars: stderr.length,
      elapsedMs: Date.now() - startedAt
    });
    sendError(request.requestId, request.messageId, normalizeProviderError(new Error(stderr.trim() || `GitHub Copilot exited with code ${code}.`)));
    await finish(request.requestId);
  });
};

const checkStatus = async (requestId: string): Promise<void> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-copilot-status-'));
  const { command, commandArgs } = getConfiguredCommand();
  const child = spawn(command, [...commandArgs, '--version'], {
    cwd: tempDir,
    env: { ...process.env, NO_COLOR: '1' }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('error', async (error) => {
    process.send?.(unavailable(requestId, normalizeProviderError(error)));
    await cleanupTempDir(tempDir);
  });
  child.once('close', async (code) => {
    const status: AgentStatusSnapshot =
      code === 0
        ? { provider, availability: 'ready' }
        : unavailable(requestId, normalizeProviderError(new Error(stderr.trim() || 'GitHub Copilot is unavailable.')));
    process.send?.({ type: 'status', requestId, ...status });
    await cleanupTempDir(tempDir);
  });
};

const cancelActive = (requestId: string): void => {
  if (!active || active.requestId !== requestId) {
    canceledRequests.add(requestId);
    return;
  }
  active.canceled = true;
  killProcessGroup(active.child);
};

const finish = async (requestId: string): Promise<void> => {
  if (!active || active.requestId !== requestId) {
    return;
  }
  const tempDir = active.tempDir;
  const mcpConfig = active.mcpConfig;
  active = undefined;
  await mcpConfig?.close();
  await cleanupTempDir(tempDir);
};

const cleanupTempDir = async (tempDir: string): Promise<void> => {
  await fs.rm(tempDir, { recursive: true, force: true });
};

const killProcessGroup = (child: ChildProcessWithoutNullStreams): void => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
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

type ActiveMcpConfig = {
  configPath: string;
  tools: LocalToolMetadata[];
  externalServers: ExternalMcpServerConfig[];
  close: () => Promise<void>;
};

const createMcpConfig = async (
  chatRequestId: string,
  tempDir: string,
  tools: LocalToolMetadata[],
  externalServers: ExternalMcpServerConfig[]
): Promise<ActiveMcpConfig | undefined> => {
  if (tools.length === 0 && externalServers.length === 0) {
    return undefined;
  }
  const startedAt = Date.now();
  const token = randomUUID();
  const serverPath = path.join(tempDir, 'review-assistant-mcp-server.mjs');
  const externalProxyPath = path.join(tempDir, 'external-mcp-proxy.mjs');
  const configPath = path.join(tempDir, 'mcp-config.json');

  let server: net.Server | undefined;
  let port: number | undefined;
  if (tools.length > 0 || externalServers.length > 0) {
    await fs.writeFile(serverPath, MCP_SERVER_SCRIPT);
    if (externalServers.length > 0) {
      await fs.writeFile(externalProxyPath, EXTERNAL_MCP_PROXY_SCRIPT);
    }
    const localServer = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let lineEnd = buffer.indexOf('\n');
        while (lineEnd >= 0) {
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          if (line.trim()) {
            void handleToolBridgeLine(chatRequestId, token, line, socket);
          }
          lineEnd = buffer.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      localServer.once('error', reject);
      localServer.listen(0, '127.0.0.1', () => {
        localServer.off('error', reject);
        resolve();
      });
    });
    const address = localServer.address();
    if (!address || typeof address === 'string') {
      localServer.close();
      throw new Error('Failed to start Review Assistant tool bridge.');
    }
    server = localServer;
    port = address.port;
  }

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          ...(tools.length > 0 && port !== undefined
            ? {
                [TOOL_SERVER_NAME]: {
                  command: process.execPath,
                  args: [serverPath],
                  timeout: 5000,
                  env: {
                    REVIEW_ASSISTANT_TOOL_HOST: '127.0.0.1',
                    REVIEW_ASSISTANT_TOOL_PORT: String(port),
                    REVIEW_ASSISTANT_TOOL_TOKEN: token,
                    REVIEW_ASSISTANT_TOOLS_JSON: JSON.stringify(tools)
                  }
                }
              }
            : {}),
          ...Object.fromEntries(
            externalServers.map((external) => [
              external.id,
              {
                command: process.execPath,
                args: [externalProxyPath],
                ...(external.timeout === undefined ? {} : { timeout: external.timeout }),
                env: {
                  ...(external.env ?? {}),
                  REVIEW_ASSISTANT_TOOL_HOST: '127.0.0.1',
                  REVIEW_ASSISTANT_TOOL_PORT: String(port),
                  REVIEW_ASSISTANT_TOOL_TOKEN: token,
                  REVIEW_ASSISTANT_EXTERNAL_MCP_ID: external.id,
                  REVIEW_ASSISTANT_EXTERNAL_MCP_COMMAND: external.command,
                  REVIEW_ASSISTANT_EXTERNAL_MCP_ARGS_JSON: JSON.stringify(external.args)
                }
              }
            ])
          )
        }
      },
      null,
      2
    )}\n`
  );
  sendLog('info', 'review-assistant.tool-bridge-ready', {
    requestId: chatRequestId,
    port: port ?? 'none',
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name).join(',') || 'none',
    externalMcpServers: externalServers.map((server) => server.id).join(',') || 'none',
    elapsedMs: Date.now() - startedAt
  });

  return {
    configPath,
    tools,
    externalServers,
    close: async () =>
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      })
  };
};

const handleToolBridgeLine = (chatRequestId: string, token: string, line: string, socket: net.Socket): void => {
  let payload: unknown;
  try {
    payload = JSON.parse(line) as unknown;
  } catch {
    socket.end(`${JSON.stringify({ ok: false, error: { code: 'INVALID_TOOL_ARGUMENTS', message: 'Invalid tool bridge payload.', retryable: false } })}\n`);
    return;
  }
  if (!isRecord(payload) || payload.token !== token || payload.type !== 'call' || typeof payload.tool !== 'string' || !isRecord(payload.arguments)) {
    if (isRecord(payload) && payload.token === token && payload.type === 'log' && typeof payload.event === 'string' && isRecord(payload.fields)) {
      sendLog('info', payload.event, { requestId: chatRequestId, ...payload.fields });
      socket.end(`${JSON.stringify({ ok: true })}\n`);
      return;
    }
    sendLog('error', 'review-assistant.tool-bridge-invalid-request', { requestId: chatRequestId });
    socket.end(`${JSON.stringify({ ok: false, error: { code: 'INVALID_TOOL_ARGUMENTS', message: 'Invalid tool bridge request.', retryable: false } })}\n`);
    return;
  }
  const toolRequestId = randomUUID();
  const toolRequest: ToolInvocationRequest = {
    tool: payload.tool,
    requestId: toolRequestId,
    arguments: payload.arguments
  };
  requestTool(chatRequestId, toolRequest)
    .then((response) => socket.end(`${JSON.stringify(response)}\n`))
    .catch((error: unknown) => {
      const response: ToolInvocationResponse = {
        requestId: toolRequestId,
        ok: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        }
      };
      socket.end(`${JSON.stringify(response)}\n`);
    });
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const sendLog = (level: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void => {
  process.send?.({ type: 'log', level, event, fields });
};

const getCopilotCommand = (prompt: string, tempDir: string, mcpConfig?: ActiveMcpConfig): { command: string; args: string[] } => {
  const { command, commandArgs } = getConfiguredCommand();
  const toolArgs = mcpConfig
    ? [
        '--additional-mcp-config',
        `@${mcpConfig.configPath}`,
        '--allow-all-tools',
        ...mcpConfig.tools.flatMap((tool) => ['--allow-tool', `${TOOL_SERVER_NAME}(${tool.name})`]),
        ...mcpConfig.externalServers.flatMap((server) => (server.allowedTools ?? []).flatMap((tool) => ['--allow-tool', `${server.id}(${tool})`]))
      ]
    : ['--available-tools', 'none'];
  return {
    command,
    args: [
      ...commandArgs,
      '-C',
      tempDir,
      '-p',
      prompt,
      '--silent',
      '--stream',
      'on',
      '--no-color',
      '--no-custom-instructions',
      '--no-ask-user',
      '--disable-builtin-mcps',
      '--disallow-temp-dir',
      ...toolArgs,
      '--log-level',
      'error'
    ]
  };
};

const getConfiguredCommand = (): { command: string; commandArgs: string[] } => ({
  command: process.env.REVIEW_ASSISTANT_COPILOT_COMMAND || 'copilot',
  commandArgs: (process.env.REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS || '').split('\n').filter(Boolean)
});

const MCP_SERVER_SCRIPT = String.raw`import net from 'node:net';

const host = process.env.REVIEW_ASSISTANT_TOOL_HOST || '127.0.0.1';
const port = Number(process.env.REVIEW_ASSISTANT_TOOL_PORT);
const token = process.env.REVIEW_ASSISTANT_TOOL_TOKEN || '';
const tools = JSON.parse(process.env.REVIEW_ASSISTANT_TOOLS_JSON || '[]');
let input = '';

void bridgeLog('review-assistant.mcp-server-started', { toolCount: tools.length });

process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  processMessages();
});

const processMessages = () => {
  while (true) {
    const lineEnd = input.indexOf('\n');
    if (lineEnd < 0) {
      return;
    }
    const line = input.slice(0, lineEnd).trim();
    input = input.slice(lineEnd + 1);
    if (line) {
      void handleMessage(JSON.parse(line));
    }
  }
};

const handleMessage = async (message) => {
  void bridgeLog('review-assistant.mcp-message-received', { method: message.method || 'response', hasId: message.id !== undefined });
  if (message.id === undefined) {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'review-assistant', version: '0.1.0' }
      }
    });
    return;
  }
  if (message.method === 'tools/list') {
    void bridgeLog('review-assistant.mcp-tools-list', { toolCount: tools.length, tools: tools.map((tool) => tool.name).join(',') || 'none' });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || { type: 'object' }
        }))
      }
    });
    return;
  }
  if (message.method === 'tools/call') {
    void bridgeLog('review-assistant.mcp-tools-call', { tool: message.params?.name || 'unknown' });
    const response = await bridgeCall(message.params?.name, message.params?.arguments || {});
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(response.ok ? response.result : response.error, null, 2) }],
        isError: !response.ok
      }
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not found' }
  });
};

const bridgeCall = async (tool, args) =>
  await new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(JSON.stringify({ token, type: 'call', tool, arguments: args }) + '\n');
    });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer));
      } catch {
        resolve({ ok: false, error: { code: 'PROVIDER_ERROR', message: 'Invalid tool bridge response.', retryable: false } });
      }
    });
    socket.on('error', (error) => {
      resolve({ ok: false, error: { code: 'PROVIDER_ERROR', message: error.message, retryable: false } });
    });
  });

async function bridgeLog(event, fields) {
  await new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end(JSON.stringify({ token, type: 'log', event, fields }) + '\n');
      resolve();
    });
    socket.on('error', () => resolve());
  });
}

const send = (message) => {
  process.stdout.write(JSON.stringify(message) + '\n');
};
`;

const EXTERNAL_MCP_PROXY_SCRIPT = String.raw`import { spawn } from 'node:child_process';
import net from 'node:net';

const serverId = process.env.REVIEW_ASSISTANT_EXTERNAL_MCP_ID || 'unknown';
const command = process.env.REVIEW_ASSISTANT_EXTERNAL_MCP_COMMAND || '';
const args = JSON.parse(process.env.REVIEW_ASSISTANT_EXTERNAL_MCP_ARGS_JSON || '[]');
const host = process.env.REVIEW_ASSISTANT_TOOL_HOST || '127.0.0.1';
const port = Number(process.env.REVIEW_ASSISTANT_TOOL_PORT);
const token = process.env.REVIEW_ASSISTANT_TOOL_TOKEN || '';
const pending = new Map();
let logQueue = Promise.resolve();
let outputQueue = Promise.resolve();
let inbound = '';
let outbound = '';

if (!command) {
  queueBridgeLog('review-assistant.external-mcp-proxy-error', { serverId, message: 'Missing external MCP command.' });
  process.exit(1);
}

queueBridgeLog('review-assistant.external-mcp-started', { serverId, argCount: args.length });

const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

process.stdin.on('data', (chunk) => {
  inbound += chunk.toString('utf8');
  processInbound();
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());

child.stdout.on('data', (chunk) => {
  outputQueue = outputQueue.then(async () => {
    const priorLogQueue = logQueue;
    outbound += chunk.toString('utf8');
    processOutbound();
    if (logQueue !== priorLogQueue) {
      await logQueue;
    }
    process.stdout.write(chunk);
  });
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  queueBridgeLog('review-assistant.external-mcp-stderr', { serverId, chars: chunk.toString('utf8').length });
});

child.once('error', async (error) => {
  queueBridgeLog('review-assistant.external-mcp-error', { serverId, message: error.message });
  await logQueue;
  process.exit(1);
});

child.once('close', async (code, signal) => {
  await outputQueue;
  queueBridgeLog('review-assistant.external-mcp-closed', { serverId, code: code ?? 'none', signal: signal ?? 'none' });
  await logQueue;
  process.exit(code ?? 0);
});

function processInbound() {
  for (const message of consumeJsonLines('inbound')) {
    if (message?.id === undefined || typeof message?.method !== 'string') {
      continue;
    }
    const id = String(message.id);
    if (message.method === 'tools/list') {
      pending.set(id, { method: 'tools/list', startedAt: Date.now() });
      queueBridgeLog('review-assistant.external-mcp-tools-list-started', { serverId });
    }
    if (message.method === 'tools/call') {
      const tool = typeof message.params?.name === 'string' ? message.params.name : 'unknown';
      pending.set(id, { method: 'tools/call', tool, startedAt: Date.now() });
      queueBridgeLog('review-assistant.external-mcp-tool-call-started', { serverId, tool });
    }
  }
}

function processOutbound() {
  for (const message of consumeJsonLines('outbound')) {
    if (message?.id === undefined) {
      continue;
    }
    const id = String(message.id);
    const pendingRequest = pending.get(id);
    if (!pendingRequest) {
      continue;
    }
    pending.delete(id);
    const elapsedMs = Date.now() - pendingRequest.startedAt;
    if (pendingRequest.method === 'tools/list') {
      const tools = Array.isArray(message.result?.tools) ? message.result.tools : [];
      queueBridgeLog('review-assistant.external-mcp-tools-list-completed', {
        serverId,
        toolCount: tools.length,
        tools: tools.map((tool) => tool?.name).filter((name) => typeof name === 'string').join(',') || 'none',
        ok: !message.error,
        elapsedMs
      });
      continue;
    }
    if (pendingRequest.method === 'tools/call') {
      const content = Array.isArray(message.result?.content) ? message.result.content : [];
      const textChars = content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0);
      queueBridgeLog('review-assistant.external-mcp-tool-call-completed', {
        serverId,
        tool: pendingRequest.tool,
        ok: !message.error && message.result?.isError !== true,
        isError: Boolean(message.error || message.result?.isError),
        contentItems: content.length,
        textChars,
        hasContent: content.length > 0 || textChars > 0,
        elapsedMs
      });
    }
  }
}

function consumeJsonLines(direction) {
  const source = direction === 'inbound' ? inbound : outbound;
  const messages = [];
  let buffer = source;
  while (true) {
    const lineEnd = buffer.indexOf('\n');
    if (lineEnd < 0) {
      break;
    }
    const line = buffer.slice(0, lineEnd).trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      messages.push(JSON.parse(line));
    } catch {
      queueBridgeLog('review-assistant.external-mcp-proxy-parse-error', { serverId, direction });
    }
  }
  if (direction === 'inbound') {
    inbound = buffer;
  } else {
    outbound = buffer;
  }
  return messages;
}

function queueBridgeLog(event, fields) {
  logQueue = logQueue.then(() => bridgeLog(event, fields));
}

async function bridgeLog(event, fields) {
  await new Promise((resolve) => {
    if (!port || !token) {
      resolve();
      return;
    }
    const socket = net.createConnection({ host, port }, () => {
      socket.end(JSON.stringify({ token, type: 'log', event, fields }) + '\n', () => resolve());
    });
    socket.once('error', () => resolve());
  });
}
`;

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
  return {
    code: 'PROVIDER_ERROR',
    message: message || 'GitHub Copilot returned an unexpected error.',
    retryable: true,
    remediation: 'Check GitHub Copilot availability and try again.'
  };
};
