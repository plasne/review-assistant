import type { FeedbackSubmissionInput, FeedbackSubmissionResult, RecordDetail, RecordSaveResult } from '../shared/types';
import { assertFeedbackSubmissionInput as assertNonEmptyFeedbackSubmission, mergeFeedbackEntries } from '../shared/feedback';
import { assertProjectId, assertRecordId } from '../shared/validators';
import { assertSubmissionAllowed, type StorageAdapter } from './storage';
import { tagPluginWarning } from './tags';

type DraftCapableStorage = StorageAdapter &
  Required<Pick<StorageAdapter, 'readRecordData' | 'renderRecordData' | 'writeRecordData' | 'writeRecordDataIfUnchanged'>>;

type DraftKey = `${string}\u0000${string}`;
type RecordDraft = {
  baseData: unknown;
  data: unknown;
};

export type RecordDraftStatus = {
  hasUnsavedChanges: boolean;
};

export class RecordDraftStore {
  private readonly drafts = new Map<DraftKey, RecordDraft>();
  private readonly loadedRecords = new Map<DraftKey, unknown>();
  private activeLeaseKey: DraftKey | undefined;

  constructor(private readonly getStorage: () => StorageAdapter) {}

  createStorageAdapter(): StorageAdapter {
    const store = this;
    const storage = this.getStorage();
    return {
      listProjects: () => storage.listProjects(),
      createProject: (projectId) => storage.createProject(projectId),
      openProject: (projectId) => storage.openProject(projectId),
      getAppPrompt: () => storage.getAppPrompt(),
      getAppConfig: () => storage.getAppConfig(),
      getAppMcpConfig: () => storage.getAppMcpConfig(),
      getRecord: (projectId, recordId) => store.getRecord(projectId, recordId),
      readRecordData: (projectId, recordId) => store.readRecordData(projectId, recordId),
      renderRecordData: (projectId, recordId, data) => store.renderRecordData(projectId, recordId, data),
      writeRecordData: (projectId, recordId, data) => store.writeRecordData(projectId, recordId, data),
      getFeedbackConfig: (projectId) => storage.getFeedbackConfig(projectId),
      saveFeedbackConfig: (projectId, config) => storage.saveFeedbackConfig(projectId, config),
      saveProjectSchema: (projectId, schema) => storage.saveProjectSchema(projectId, schema),
      getProjectUser: (projectId) => storage.getProjectUser(projectId),
      submitFeedback: (projectId, recordId, input) => store.submitFeedback(projectId, recordId, input),
      updateRecord: (projectId, recordId, data) => store.updateRecord(projectId, recordId, data),
      getProjectPrompt: (projectId) => storage.getProjectPrompt(projectId),
      getProjectConfig: (projectId) => storage.getProjectConfig(projectId),
      getProjectMcpConfig: (projectId) => storage.getProjectMcpConfig(projectId),
      getTagDefinitions: (projectId) => storage.getTagDefinitions(projectId),
      reconcileRecordTags: (projectId, data) => storage.reconcileRecordTags(projectId, data),
      obtainExclusiveLease: (projectId, recordId) => storage.obtainExclusiveLease(projectId, recordId),
      releaseExclusiveLease: (projectId, recordId) => storage.releaseExclusiveLease(projectId, recordId),
      listQueues: () => storage.listQueues(),
      createQueue: (queueName) => storage.createQueue(queueName),
      deleteQueue: (queueName) => storage.deleteQueue(queueName),
      clearQueue: (queueName) => storage.clearQueue(queueName),
      enqueueMessage: (queueName, message) => storage.enqueueMessage(queueName, message),
      dequeueMessage: (queueName) => storage.dequeueMessage(queueName),
      completeMessage: (queueName, popReceipt) => storage.completeMessage(queueName, popReceipt),
      searchRecords: (projectId, tagFilter) => storage.searchRecords(projectId, tagFilter)
    };
  }

  getStatus(projectId: string, recordId: string): RecordDraftStatus {
    return { hasUnsavedChanges: this.drafts.has(this.key(projectId, recordId)) };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const key = this.key(projectId, recordId);
    await this.activateLease(projectId, recordId);
    const draft = this.drafts.get(key);
    if (draft) {
      return this.renderRecordData(projectId, recordId, cloneJson(draft.data));
    }
    try {
      const data = cloneJson(await this.requireDraftCapableStorage().readRecordData(projectId, recordId));
      this.loadedRecords.set(key, cloneJson(data));
      return this.renderRecordData(projectId, recordId, data);
    } catch (error) {
      await this.releaseLease(projectId, recordId);
      throw error;
    }
  }

  async createRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const key = this.key(projectId, recordId);
    if (this.drafts.has(key)) {
      throw new Error(`Record draft already exists: ${recordId}`);
    }
    try {
      await this.requireDraftCapableStorage().readRecordData(projectId, recordId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Record not found:')) {
        const data = {};
        this.drafts.set(key, { baseData: undefined, data });
        return this.renderRecordData(projectId, recordId, data);
      }
      throw error;
    }
    throw new Error(`Record already exists: ${recordId}`);
  }

  async readRecordData(projectId: string, recordId: string): Promise<unknown> {
    const key = this.key(projectId, recordId);
    const draft = this.drafts.get(key);
    if (draft) {
      return cloneJson(draft.data);
    }
    if (this.loadedRecords.has(key)) {
      return cloneJson(this.loadedRecords.get(key));
    }
    return cloneJson(await this.requireDraftCapableStorage().readRecordData(projectId, recordId));
  }

  async renderRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    return this.requireDraftCapableStorage().renderRecordData(projectId, recordId, data);
  }

  async writeRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    await this.stageDraft(projectId, recordId, data);
    return this.renderRecordData(projectId, recordId, data);
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const existing = await this.readRecordData(projectId, recordId);
    const feedback = isPlainRecord(existing) ? feedbackProperties(existing) : {};
    const next = isPlainRecord(data) ? { ...cloneJson(data), ...feedback } : cloneJson(data);
    await this.stageDraft(projectId, recordId, next);
    return this.renderRecordData(projectId, recordId, next);
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const config = await this.getStorage().getFeedbackConfig(projectId);
    assertSubmissionAllowed(config, validInput);
    const user = await this.getStorage().getProjectUser(projectId);
    if (!user.valid || !user.username) {
      throw new Error(user.validationMessage);
    }
    const data = await this.readRecordData(projectId, recordId);
    if (!isPlainRecord(data)) {
      throw new Error('Feedback can only be added to object records.');
    }
    mergeFeedbackEntries(data, validInput, user.username);
    await this.stageDraft(projectId, recordId, data);
    return { username: user.username, record: await this.renderRecordData(projectId, recordId, data) };
  }

  async saveDraft(projectId: string, recordId: string, action: 'saved' | 'reviewed' = 'saved'): Promise<RecordSaveResult> {
    const key = this.key(projectId, recordId);
    const draft = this.drafts.get(key);
    if (!draft) {
      return { record: await this.getStorage().getRecord(projectId, recordId) };
    }
    const data = cloneJson(draft.data);
    const reconciled = await this.getStorage().reconcileRecordTags(projectId, data);
    await this.appendHistory(projectId, reconciled.data, action);
    const record = await this.requireDraftCapableStorage().writeRecordDataIfUnchanged(projectId, recordId, reconciled.data, draft.baseData);
    this.drafts.delete(key);
    this.loadedRecords.set(key, cloneJson(reconciled.data));
    return { record, ...(reconciled.pluginErrors.length > 0 ? { tagPluginWarning: tagPluginWarning(reconciled.pluginErrors) } : {}) };
  }

  async computeTags(projectId: string, recordId: string): Promise<RecordSaveResult> {
    const data = await this.readRecordData(projectId, recordId);
    const reconciled = await this.getStorage().reconcileRecordTags(projectId, data);
    await this.stageDraft(projectId, recordId, reconciled.data);
    return {
      record: await this.renderRecordData(projectId, recordId, reconciled.data),
      ...(reconciled.pluginErrors.length > 0 ? { tagPluginWarning: tagPluginWarning(reconciled.pluginErrors, 'Tags computed') } : {})
    };
  }

  discardDraft(projectId: string, recordId: string): RecordDraftStatus {
    this.drafts.delete(this.key(projectId, recordId));
    return this.getStatus(projectId, recordId);
  }

  async releaseForProjectChange(projectId: string): Promise<void> {
    const active = this.activeLeaseKey;
    if (!active) {
      return;
    }
    const [activeProjectId, activeRecordId] = this.parseKey(active);
    if (activeProjectId !== assertProjectId(projectId)) {
      await this.releaseLease(activeProjectId, activeRecordId);
    }
  }

  async releaseAll(): Promise<void> {
    const active = this.activeLeaseKey;
    if (!active) {
      return;
    }
    const [projectId, recordId] = this.parseKey(active);
    await this.releaseLease(projectId, recordId);
  }

  private key(projectId: string, recordId: string): DraftKey {
    return `${assertProjectId(projectId)}\u0000${assertRecordId(recordId)}`;
  }

  private requireDraftCapableStorage(): DraftCapableStorage {
    const storage = this.getStorage();
    if (!storage.readRecordData || !storage.renderRecordData || !storage.writeRecordData || !storage.writeRecordDataIfUnchanged) {
      throw new Error('Storage backend does not support record drafts.');
    }
    return storage as DraftCapableStorage;
  }

  private async stageDraft(projectId: string, recordId: string, data: unknown): Promise<void> {
    const key = this.key(projectId, recordId);
    const current = this.drafts.get(key);
    const baseData = current ? current.baseData : this.loadedRecords.has(key) ? this.loadedRecords.get(key) : await this.requireDraftCapableStorage().readRecordData(projectId, recordId);
    this.drafts.set(key, {
      baseData: cloneJson(baseData),
      data: cloneJson(data)
    });
  }

  private async appendHistory(projectId: string, data: unknown, action: 'saved' | 'reviewed'): Promise<void> {
    if (!isPlainRecord(data)) {
      throw new Error('Record history can only be added to object records.');
    }
    const user = await this.getStorage().getProjectUser(projectId);
    if (!user.valid || !user.username) {
      throw new Error(user.validationMessage);
    }
    const currentHistory = data._history;
    if (currentHistory !== undefined && !Array.isArray(currentHistory)) {
      throw new Error('Record _history must be an array.');
    }
    data._history = [
      ...(Array.isArray(currentHistory) ? currentHistory : []),
      { username: user.username, timestamp: new Date().toISOString(), action }
    ];
  }

  private async activateLease(projectId: string, recordId: string): Promise<void> {
    const key = this.key(projectId, recordId);
    if (this.activeLeaseKey === key) {
      return;
    }
    const previous = this.activeLeaseKey;
    if (previous) {
      const [previousProjectId, previousRecordId] = this.parseKey(previous);
      await this.releaseLease(previousProjectId, previousRecordId);
    }
    const lease = await this.getStorage().obtainExclusiveLease(projectId, recordId);
    if (lease.status === 'FAILURE') {
      throw new Error(`Record is already open in another session: ${recordId}`);
    }
    if (lease.status === 'SUCCESS') {
      this.activeLeaseKey = key;
    }
  }

  private async releaseLease(projectId: string, recordId: string): Promise<void> {
    const key = this.key(projectId, recordId);
    this.loadedRecords.delete(key);
    if (this.activeLeaseKey !== key) {
      return;
    }
    this.activeLeaseKey = undefined;
    await this.getStorage().releaseExclusiveLease(projectId, recordId);
  }

  private parseKey(key: DraftKey): [string, string] {
    const [projectId, recordId] = key.split('\u0000');
    if (!projectId || !recordId) {
      throw new Error('Invalid record draft key.');
    }
    return [projectId, recordId];
  }
}

const feedbackProperties = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('_feedback') || key === '_history'));

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
