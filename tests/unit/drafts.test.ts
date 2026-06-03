import { describe, expect, it } from 'vitest';
import { RecordDraftStore } from '../../src/main/drafts';
import type { StorageAdapter } from '../../src/main/storage';
import { stripFeedbackProperties } from '../../src/shared/feedback';

describe('record draft store', () => {
  it('stages record updates until the explicit save boundary', async () => {
    let stored: unknown = { answer: 'Original', evidence: [{ id: 'doc-1' }] };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    await drafts.updateRecord('sample-project', 'record-1', { answer: 'Draft', evidence: [{ id: 'doc-1' }, { id: 'doc-2' }] });

    expect(stored).toEqual({ answer: 'Original', evidence: [{ id: 'doc-1' }] });
    await expect(drafts.getRecord('sample-project', 'record-1')).resolves.toMatchObject({
      data: { answer: 'Draft', evidence: [{ id: 'doc-1' }, { id: 'doc-2' }] }
    });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });

    await drafts.saveDraft('sample-project', 'record-1');

    expect(stored).toEqual({ answer: 'Draft', evidence: [{ id: 'doc-1' }, { id: 'doc-2' }] });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: false });
  });

  it('stages feedback submissions and persists them only on save', async () => {
    let stored: unknown = { answer: 'Original' };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    const submitted = await drafts.submitFeedback('sample-project', 'record-1', {
      propertyPath: '/answer',
      feedbackValue: 'good',
      editValue: 'Updated'
    });

    expect(submitted.record.data).toEqual({ answer: 'Updated' });
    expect(stored).toEqual({ answer: 'Original' });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });

    await drafts.saveDraft('sample-project', 'record-1');

    expect(stored).toMatchObject({
      answer: 'Updated',
      answer_feedback: expect.arrayContaining([expect.objectContaining({ feedback: 'good', edit: 'Updated', username: 'sme@example.com' })])
    });
  });

  it('rejects saving a draft when the persisted record changed after staging', async () => {
    let stored: unknown = { answer: 'Original' };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    await drafts.submitFeedback('sample-project', 'record-1', {
      propertyPath: '/answer',
      feedbackValue: 'good',
      editValue: 'Updated'
    });
    stored = {
      answer: 'Original',
      answer_feedback: [{ feedback: 'fair', username: 'other@example.com', timestamp: '2026-06-02T20:00:00.000Z' }]
    };

    await expect(drafts.saveDraft('sample-project', 'record-1')).rejects.toThrow('Record changed after this draft was staged');

    expect(stored).toEqual({
      answer: 'Original',
      answer_feedback: [{ feedback: 'fair', username: 'other@example.com', timestamp: '2026-06-02T20:00:00.000Z' }]
    });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });
  });
});

const createStorage = (read: () => unknown, write: (value: unknown) => void): StorageAdapter => ({
  listProjects: async () => [],
  createProject: async (projectId) => ({ id: projectId, name: projectId }),
  openProject: async (projectId) => ({ project: { id: projectId, name: projectId }, schema: {}, records: [], projectConfig: {} }),
  getRecord: async (projectId, recordId) => createRecordDetail(projectId, recordId, read()),
  readRecordData: async () => clone(read()),
  renderRecordData: async (projectId, recordId, data) => createRecordDetail(projectId, recordId, data),
  writeRecordData: async (projectId, recordId, data) => {
    write(clone(data));
    return createRecordDetail(projectId, recordId, data);
  },
  writeRecordDataIfUnchanged: async (projectId, recordId, data, expectedData) => {
    if (JSON.stringify(read()) !== JSON.stringify(expectedData)) {
      throw new Error('Record changed after this draft was staged. Refresh the record, review the latest changes, and stage your edits again.');
    }
    write(clone(data));
    return createRecordDetail(projectId, recordId, data);
  },
  getFeedbackConfig: async () => ({
    properties: {
      '/answer': {
        path: '/answer',
        target: 'Answer',
        tab: 'Main',
        supportsEdit: true,
        feedback: 'good_fair_bad',
        comments: false,
        editMode: 'logged'
      }
    }
  }),
  saveFeedbackConfig: async (_projectId, config) => config,
  getProjectUser: async () => ({ username: 'sme@example.com', valid: true }),
  submitFeedback: async (projectId, recordId) => ({ username: 'sme@example.com', record: createRecordDetail(projectId, recordId, read()) }),
  updateRecord: async (projectId, recordId, data) => {
    write(clone(data));
    return createRecordDetail(projectId, recordId, data);
  },
  getProjectPrompt: async () => undefined,
  getProjectConfig: async () => ({}),
  getProjectMcpConfig: async () => undefined
});

const createRecordDetail = (projectId: string, recordId: string, data: unknown) => ({
  projectId,
  recordId,
  displayName: recordId,
  data: stripFeedbackProperties(clone(data)),
  schema: {},
  validationIssues: [],
  renderTree: { kind: 'object' as const, label: 'record', children: [], validationIssues: [] }
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
