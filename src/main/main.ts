import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_VERSION } from '../generated/version';
import { logError, logInfo } from '../shared/logging';
import type { AppBootstrap, ChatAttachmentContent } from '../shared/types';
import {
  assertChatCancelResult,
  assertChatAttachmentContents,
  assertChatAttachments,
  assertChatAttachmentSelectionResult,
  assertBootstrap,
  assertChatMessage,
  assertChatHistory,
  assertFeedbackConfig,
  assertFeedbackSubmissionInput,
  assertFeedbackSubmissionResult,
  assertContinueWithGitHubResult,
  assertGitHubLoginCompletion,
  assertNewProjectId,
  assertOpenProjectResult,
  assertProjectId,
  assertProjectUser,
  assertProjectSummary,
  assertProjectSummaries,
  assertRecordDraftStatus,
  assertRecordDetail,
  assertRecordSaveResult,
  assertRecordId,
  assertChatAttachmentId
} from '../shared/validators';
import { ConfigError, loadAppConfig } from './env';
import { createStorageAdapter, type StorageAdapter } from './storage';
import { AgentRuntime, AgentRuntimeError } from './agent';
import { createLocalToolRuntime } from './tools';
import { mergeExternalMcpServers, parseExternalMcpServers } from './mcp';
import { startCopilotLogin } from './copilot-auth';
import { RecordDraftStore } from './drafts';

let mainWindow: BrowserWindow | undefined;
let storage: StorageAdapter | undefined;
let bootstrapError: string | undefined;
let backendKind: AppBootstrap['backendKind'];
let appConfigValues: Record<string, string> = {};
let appMcpConfigPath: string | undefined;
let appPromptPath: string | undefined;
let allowClose = false;
const agent = new AgentRuntime({ workerPath: path.join(__dirname, '../agent/agent-process.js') });
const attachmentCache = new Map<string, ChatAttachmentContent>();
const MAX_ATTACHMENT_BYTES = 64 * 1024;
const TEXT_ATTACHMENT_FILTERS = [
  {
    name: 'Text files',
    extensions: ['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'csv', 'tsv', 'log', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql']
  }
];

const initializeBackend = (): void => {
  try {
    const config = loadAppConfig();
    storage = createStorageAdapter(config);
    backendKind = config.backendKind;
    appConfigValues = config.values;
    agent.setAgentSettings(config.agentSettings ?? {});
    appMcpConfigPath = path.join(path.dirname(config.appEnvPath), 'mcp.json');
    appPromptPath = path.join(path.dirname(config.appEnvPath), 'prompt.md');
  } catch (error) {
    bootstrapError = error instanceof ConfigError || error instanceof Error ? error.message : String(error);
    logError('review-assistant.config-error', { message: bootstrapError });
  }
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.on('close', (event) => {
    if (allowClose) {
      return;
    }
    event.preventDefault();
    mainWindow?.webContents.send('app:close-requested');
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    return;
  }
  await mainWindow.loadURL(pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString());
};

const requireStorage = (): StorageAdapter => {
  if (!storage) {
    throw new Error(bootstrapError ?? 'Storage backend is not configured.');
  }
  return storage;
};

const drafts = new RecordDraftStore(requireStorage);

const readOptionalTextFile = async (filePath: string | undefined): Promise<string | undefined> => {
  if (!filePath) {
    return undefined;
  }
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readChatAttachment = async (filePath: string): Promise<ChatAttachmentContent> => {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Chat attachments must be files: ${filePath}`);
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Chat attachment is too large: ${path.basename(filePath)}. Select a text file under 64 KB.`);
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    throw new Error(`Chat attachment must be a text file: ${path.basename(filePath)}`);
  }
  const content = buffer.toString('utf8');
  if (content.includes('\uFFFD')) {
    throw new Error(`Chat attachment must be valid UTF-8 text: ${path.basename(filePath)}`);
  }
  return assertChatAttachmentContents([
    {
      id: randomUUID(),
      name: path.basename(filePath),
      path: filePath,
      sizeBytes: stat.size,
      content
    }
  ])[0];
};

const resolveCachedAttachments = (attachments: unknown): ChatAttachmentContent[] => {
  const requested = assertChatAttachments(attachments);
  const resolved = requested.map((attachment) => {
    const cached = attachmentCache.get(attachment.id);
    if (!cached) {
      throw new Error(`Chat attachment is no longer available: ${attachment.name}`);
    }
    return cached;
  });
  const validAttachments = assertChatAttachmentContents(resolved);
  attachmentCache.clear();
  return validAttachments;
};

const registerIpc = (): void => {
  ipcMain.handle('app:getBootstrap', async () => {
    const projects = storage ? await storage.listProjects() : [];
    return assertBootstrap({ configError: bootstrapError, backendKind, projects, version: APP_VERSION });
  });
  ipcMain.handle('projects:list', async () => assertProjectSummaries(await requireStorage().listProjects()));
  ipcMain.handle('projects:create', async (_event, projectId: unknown) =>
    assertProjectSummary(await requireStorage().createProject(assertNewProjectId(projectId)))
  );
  ipcMain.handle('projects:open', async (_event, projectId: unknown) =>
    assertOpenProjectResult(await requireStorage().openProject(assertProjectId(projectId)))
  );
  ipcMain.handle('records:createDraft', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordDetail(await drafts.createRecord(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('records:get', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordDetail(await drafts.getRecord(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('records:updateData', async (_event, projectId: unknown, recordId: unknown, data: unknown) =>
    assertRecordDetail(await drafts.updateRecord(assertProjectId(projectId), assertRecordId(recordId), data))
  );
  ipcMain.handle('records:computeTags', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordSaveResult(await drafts.computeTags(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('records:getDraftStatus', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordDraftStatus(drafts.getStatus(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('records:saveChanges', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordSaveResult(await drafts.saveDraft(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('records:discardChanges', async (_event, projectId: unknown, recordId: unknown) =>
    assertRecordDraftStatus(drafts.discardDraft(assertProjectId(projectId), assertRecordId(recordId)))
  );
  ipcMain.handle('feedback:getConfig', async (_event, projectId: unknown) =>
    assertFeedbackConfig(await requireStorage().getFeedbackConfig(assertProjectId(projectId)))
  );
  ipcMain.handle('feedback:saveConfig', async (_event, projectId: unknown, config: unknown) =>
    assertFeedbackConfig(await requireStorage().saveFeedbackConfig(assertProjectId(projectId), assertFeedbackConfig(config)))
  );
  ipcMain.handle('feedback:getProjectUser', async (_event, projectId: unknown) =>
    assertProjectUser(await requireStorage().getProjectUser(assertProjectId(projectId)))
  );
  ipcMain.handle('feedback:submit', async (_event, projectId: unknown, recordId: unknown, input: unknown) =>
    assertFeedbackSubmissionResult(
      await drafts.submitFeedback(assertProjectId(projectId), assertRecordId(recordId), assertFeedbackSubmissionInput(input))
    )
  );
  ipcMain.handle('app:closeWindow', () => {
    allowClose = true;
    mainWindow?.close();
  });
  ipcMain.handle('agent:getStatus', async () => agent.getStatus());
  ipcMain.handle('chat:selectAttachments', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options = {
      title: 'Attach text files to chat',
      properties: ['openFile', 'multiSelections'],
      filters: TEXT_ATTACHMENT_FILTERS
    } satisfies Electron.OpenDialogOptions;
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return assertChatAttachmentSelectionResult({ attachments: [] });
    }
    attachmentCache.clear();
    const attachments = assertChatAttachmentContents(await Promise.all(result.filePaths.map(readChatAttachment)));
    for (const attachment of attachments) {
      attachmentCache.set(attachment.id, attachment);
    }
    return assertChatAttachmentSelectionResult({ attachments });
  });
  ipcMain.handle('chat:discardAttachment', async (_event, attachmentId: unknown) => {
    attachmentCache.delete(assertChatAttachmentId(attachmentId));
  });
  ipcMain.handle('auth:continueWithGitHub', async (event) => {
    logInfo('review-assistant.auth-login-started', { provider: 'github-copilot' });
    const sender = event.sender;
    const result = await startCopilotLogin({
      onComplete: (completion) => {
        const validCompletion = assertGitHubLoginCompletion(completion);
        logInfo('review-assistant.auth-login-completed', {
          loginId: validCompletion.loginId,
          provider: 'github-copilot',
          success: validCompletion.success
        });
        if (!sender.isDestroyed()) {
          sender.send('auth:login-completed', validCompletion);
        }
      }
    });
    if (result.deviceCode) {
      clipboard.writeText(result.deviceCode);
      result.copiedToClipboard = true;
      logInfo('review-assistant.auth-device-code-ready', {
        copiedToClipboard: result.copiedToClipboard,
        provider: 'github-copilot'
      });
    }
    return assertContinueWithGitHubResult(result);
  });
  ipcMain.handle('chat:start', async (event, projectId: unknown, recordId: unknown, message: unknown, history: unknown, attachments: unknown) => {
    const startedAt = Date.now();
    const validProjectId = projectId === undefined ? undefined : assertProjectId(projectId);
    const validRecordId = recordId === undefined ? undefined : assertRecordId(recordId);
    const validMessage = assertChatMessage(message);
    const validHistory = assertChatHistory(history);
    const validAttachments = resolveCachedAttachments(attachments);
    if (validRecordId && !validProjectId) {
      throw new Error('A project must be selected before sending selected record context.');
    }
    const activeStorage = validProjectId ? requireStorage() : storage;
    const appPrompt = await readOptionalTextFile(appPromptPath);
    const projectPrompt = activeStorage && validProjectId ? await activeStorage.getProjectPrompt(validProjectId) : undefined;
    const systemPrompt = [appPrompt, projectPrompt].filter((prompt): prompt is string => Boolean(prompt?.trim())).join('\n\n') || undefined;
    const projectConfig = activeStorage && validProjectId ? await activeStorage.getProjectConfig(validProjectId) : {};
    const appMcpConfig = await readOptionalTextFile(appMcpConfigPath);
    const projectMcpConfig = activeStorage && validProjectId ? await activeStorage.getProjectMcpConfig(validProjectId) : undefined;
    const appMcpServers = parseExternalMcpServers(appMcpConfig, appConfigValues);
    const projectMcpServers = parseExternalMcpServers(projectMcpConfig, { ...appConfigValues, ...projectConfig });
    const mcpServers = mergeExternalMcpServers(appMcpServers, projectMcpServers);
    const toolStorage = validProjectId ? drafts.createStorageAdapter() : activeStorage;
    const tools = createLocalToolRuntime({
      storage: toolStorage,
      selectedProjectId: validProjectId,
      selectedRecordId: validRecordId
    });
    const toolList = tools.listTools();
    logInfo('review-assistant.chat-start-context', {
      projectId: validProjectId ?? 'none',
      recordId: validRecordId ?? 'none',
      messageChars: validMessage.length,
      historyMessageCount: validHistory.length,
      historyChars: validHistory.reduce((total, item) => total + item.content.length, 0),
      attachmentCount: validAttachments.length,
      attachmentChars: validAttachments.reduce((total, attachment) => total + attachment.content.length, 0),
      systemPromptSource: appPrompt && projectPrompt ? 'app+project' : projectPrompt ? 'project' : appPrompt ? 'app' : 'none',
      systemPromptChars: systemPrompt?.length ?? 0,
      toolCount: toolList.length,
      tools: toolList.map((tool) => tool.name).join(',') || 'none',
      externalMcpServers: mcpServers.map((server) => server.id).join(',') || 'none',
      contextMs: Date.now() - startedAt
    });
    try {
      return await agent.start(
        {
          message: validMessage,
          history: validHistory,
          attachments: validAttachments,
          projectId: validProjectId,
          recordId: validRecordId,
          systemPrompt,
          agentSettings: agent.getAgentSettings(),
          tools: toolList,
          mcpServers
        },
        {
          chunk: (chunk) => event.sender.send('chat:chunk', chunk),
          complete: (complete) => event.sender.send('chat:complete', complete),
          error: (error) => event.sender.send('chat:error', error),
          canceled: (canceled) => event.sender.send('chat:canceled', canceled)
        },
        tools
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError) {
        throw new Error(error.envelope.remediation ? `${error.envelope.message} ${error.envelope.remediation}` : error.envelope.message);
      }
      throw error;
    }
  });
  ipcMain.handle('chat:cancel', async (_event, requestId: unknown) => {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw new Error('Invalid chat request identifier.');
    }
    return assertChatCancelResult({ requestId, canceled: agent.cancel(requestId) });
  });
};

app.whenReady().then(async () => {
  initializeBackend();
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  agent.cancelAll();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
