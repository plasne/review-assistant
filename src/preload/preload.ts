import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/types';
import {
  assertAgentStatus,
  assertBootstrap,
  assertChatCanceled,
  assertChatCancelResult,
  assertNewProjectId,
  assertOpenProjectResult,
  assertProjectId,
  assertProjectSummary,
  assertProjectSummaries,
  assertRecordDraftStatus,
  assertRecordDetail,
  assertRecordSaveResult,
  assertRecordId,
  assertChatMessage,
  assertChatAttachmentId,
  assertChatAttachments,
  assertChatAttachmentSelectionResult,
  assertChatHistory,
  assertChatStreamChunk,
  assertChatStreamComplete,
  assertChatStreamError,
  assertChatStreamStart,
  assertContinueWithGitHubResult,
  assertDequeueResult,
  assertFeedbackConfig,
  assertFeedbackSubmissionInput,
  assertFeedbackSubmissionResult,
  assertGitHubLoginCompletion,
  assertProjectUser,
  assertQueueInfos,
  assertQueueMessage,
  assertQueueName,
  assertTheme,
  assertThemeId,
  assertThemeState,
  assertRecordSaveOptions,
  assertRecordSummaries,
  assertTagFilter,
  assertTagNameArray
} from '../shared/validators';

const invoke = async <T>(channel: string, validator: (value: unknown) => T, ...args: unknown[]): Promise<T> =>
  validator(await ipcRenderer.invoke(channel, ...args));

const onEvent = <T>(channel: string, validator: (value: unknown) => T, listener: (value: T) => void): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    listener(validator(value));
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const api: Api = {
  getBootstrap: () => invoke('app:getBootstrap', assertBootstrap),
  listProjects: () => invoke('projects:list', assertProjectSummaries),
  createProject: (projectId) => invoke('projects:create', assertProjectSummary, assertNewProjectId(projectId)),
  openProject: (projectId) => invoke('projects:open', assertOpenProjectResult, assertProjectId(projectId)),
  listProjectTags: (projectId) => invoke('projects:listTags', assertTagNameArray, assertProjectId(projectId)),
  createRecordDraft: (projectId, recordId) =>
    invoke('records:createDraft', assertRecordDetail, assertProjectId(projectId), assertRecordId(recordId)),
  getRecord: (projectId, recordId) => invoke('records:get', assertRecordDetail, assertProjectId(projectId), assertRecordId(recordId)),
  updateRecordData: (projectId, recordId, data) =>
    invoke('records:updateData', assertRecordDetail, assertProjectId(projectId), assertRecordId(recordId), data),
  computeRecordTags: (projectId, recordId) =>
    invoke('records:computeTags', assertRecordSaveResult, assertProjectId(projectId), assertRecordId(recordId)),
  getRecordDraftStatus: (projectId, recordId) =>
    invoke('records:getDraftStatus', assertRecordDraftStatus, assertProjectId(projectId), assertRecordId(recordId)),
  saveRecordChanges: (projectId, recordId, options) =>
    invoke('records:saveChanges', assertRecordSaveResult, assertProjectId(projectId), assertRecordId(recordId), assertRecordSaveOptions(options)),
  discardRecordChanges: (projectId, recordId) =>
    invoke('records:discardChanges', assertRecordDraftStatus, assertProjectId(projectId), assertRecordId(recordId)),
  queue: {
    listQueues: () => invoke('queue:listQueues', assertQueueInfos),
    createQueue: (queueName) => invoke('queue:createQueue', (value) => assertQueueInfos([value])[0], assertQueueName(queueName)),
    deleteQueue: async (queueName) => {
      await ipcRenderer.invoke('queue:deleteQueue', assertQueueName(queueName));
    },
    clearQueue: async (queueName) => {
      await ipcRenderer.invoke('queue:clearQueue', assertQueueName(queueName));
    },
    searchRecords: (projectId, tagFilter) =>
      invoke('queue:searchRecords', assertRecordSummaries, assertProjectId(projectId), assertTagFilter(tagFilter)),
    enqueueMessage: async (queueName, message) => {
      await ipcRenderer.invoke('queue:enqueueMessage', assertQueueName(queueName), assertQueueMessage(message));
    },
    dequeueMessage: (queueName) => invoke('queue:dequeueMessage', assertDequeueResult, assertQueueName(queueName))
  },
  getFeedbackConfig: (projectId) => invoke('feedback:getConfig', assertFeedbackConfig, assertProjectId(projectId)),
  saveFeedbackConfig: (projectId, config) => invoke('feedback:saveConfig', assertFeedbackConfig, assertProjectId(projectId), assertFeedbackConfig(config)),
  getThemeState: () => invoke('theme:getState', assertThemeState),
  saveTheme: (theme) => invoke('theme:save', assertThemeState, assertTheme(theme)),
  deleteTheme: (themeId) => invoke('theme:delete', assertThemeState, assertThemeId(themeId)),
  setActiveTheme: (themeId) => invoke('theme:setActive', assertThemeState, assertThemeId(themeId)),
  getProjectUser: (projectId) => invoke('feedback:getProjectUser', assertProjectUser, assertProjectId(projectId)),
  submitFeedback: (projectId, recordId, input) =>
    invoke(
      'feedback:submit',
      assertFeedbackSubmissionResult,
      assertProjectId(projectId),
      assertRecordId(recordId),
      assertFeedbackSubmissionInput(input)
    ),
  getAgentStatus: () => invoke('agent:getStatus', assertAgentStatus),
  continueWithGitHub: () => invoke('auth:continueWithGitHub', assertContinueWithGitHubResult),
  closeWindow: async () => {
    await ipcRenderer.invoke('app:closeWindow');
  },
  startChat: (projectId, recordId, message, history, attachments) =>
    invoke(
      'chat:start',
      assertChatStreamStart,
      projectId ? assertProjectId(projectId) : undefined,
      recordId ? assertRecordId(recordId) : undefined,
      assertChatMessage(message),
      assertChatHistory(history),
      assertChatAttachments(attachments)
    ),
  selectChatAttachments: () => invoke('chat:selectAttachments', assertChatAttachmentSelectionResult),
  discardChatAttachment: async (attachmentId) => {
    await ipcRenderer.invoke('chat:discardAttachment', assertChatAttachmentId(attachmentId));
  },
  cancelChat: (requestId) => invoke('chat:cancel', assertChatCancelResult, requestId),
  onChatChunk: (listener) => onEvent('chat:chunk', assertChatStreamChunk, listener),
  onChatComplete: (listener) => onEvent('chat:complete', assertChatStreamComplete, listener),
  onChatError: (listener) => onEvent('chat:error', assertChatStreamError, listener),
  onChatCanceled: (listener) => onEvent('chat:canceled', assertChatCanceled, listener),
  onGitHubLoginComplete: (listener) => onEvent('auth:login-completed', assertGitHubLoginCompletion, listener),
  onCloseRequested: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('app:close-requested', wrapped);
    return () => ipcRenderer.removeListener('app:close-requested', wrapped);
  }
};

contextBridge.exposeInMainWorld('reviewAssistant', api);
