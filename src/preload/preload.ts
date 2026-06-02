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
  assertRecordDetail,
  assertRecordId,
  assertChatMessage,
  assertChatHistory,
  assertChatStreamChunk,
  assertChatStreamComplete,
  assertChatStreamError,
  assertChatStreamStart,
  assertFeedbackConfig,
  assertFeedbackSubmissionInput,
  assertFeedbackSubmissionResult,
  assertProjectUser
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
  getRecord: (projectId, recordId) => invoke('records:get', assertRecordDetail, assertProjectId(projectId), assertRecordId(recordId)),
  getFeedbackConfig: (projectId) => invoke('feedback:getConfig', assertFeedbackConfig, assertProjectId(projectId)),
  saveFeedbackConfig: (projectId, config) => invoke('feedback:saveConfig', assertFeedbackConfig, assertProjectId(projectId), assertFeedbackConfig(config)),
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
  startChat: (projectId, recordId, message, history) =>
    invoke(
      'chat:start',
      assertChatStreamStart,
      projectId ? assertProjectId(projectId) : undefined,
      recordId ? assertRecordId(recordId) : undefined,
      assertChatMessage(message),
      assertChatHistory(history)
    ),
  cancelChat: (requestId) => invoke('chat:cancel', assertChatCancelResult, requestId),
  onChatChunk: (listener) => onEvent('chat:chunk', assertChatStreamChunk, listener),
  onChatComplete: (listener) => onEvent('chat:complete', assertChatStreamComplete, listener),
  onChatError: (listener) => onEvent('chat:error', assertChatStreamError, listener),
  onChatCanceled: (listener) => onEvent('chat:canceled', assertChatCanceled, listener)
};

contextBridge.exposeInMainWorld('reviewAssistant', api);
