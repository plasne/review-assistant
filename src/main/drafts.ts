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

  constructor(private readonly getStorage: () => StorageAdapter) {}

  createStorageAdapter(): StorageAdapter {
    const store = this;
    const storage = this.getStorage();
    return {
      listProjects: () => storage.listProjects(),
      createProject: (projectId) => storage.createProject(projectId),
      openProject: (projectId) => storage.openProject(projectId),
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
      reconcileRecordTags: (projectId, data) => storage.reconcileRecordTags(projectId, data)
    };
  }

  getStatus(projectId: string, recordId: string): RecordDraftStatus {
    return { hasUnsavedChanges: this.drafts.has(this.key(projectId, recordId)) };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    return this.renderRecordData(projectId, recordId, await this.readRecordData(projectId, recordId));
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

  async saveDraft(projectId: string, recordId: string): Promise<RecordSaveResult> {
    const key = this.key(projectId, recordId);
    const draft = this.drafts.get(key);
    if (!draft) {
      return { record: await this.getStorage().getRecord(projectId, recordId) };
    }
    const data = cloneJson(draft.data);
    const reconciled = await this.getStorage().reconcileRecordTags(projectId, data);
    const record = await this.requireDraftCapableStorage().writeRecordDataIfUnchanged(projectId, recordId, reconciled.data, draft.baseData);
    this.drafts.delete(key);
    return { record, ...(reconciled.pluginErrors.length > 0 ? { tagPluginWarning: tagPluginWarning(reconciled.pluginErrors) } : {}) };
  }

  discardDraft(projectId: string, recordId: string): RecordDraftStatus {
    this.drafts.delete(this.key(projectId, recordId));
    return this.getStatus(projectId, recordId);
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
    this.drafts.set(key, {
      baseData: current ? current.baseData : cloneJson(await this.requireDraftCapableStorage().readRecordData(projectId, recordId)),
      data: cloneJson(data)
    });
  }
}

const feedbackProperties = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key.endsWith('_feedback') || key.endsWith('_edits') || key.endsWith('_comments')));

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
