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

    expect(stored).toMatchObject({
      answer: 'Draft',
      evidence: [{ id: 'doc-1' }, { id: 'doc-2' }],
      _history: [expect.objectContaining({ username: 'sme@example.com', action: 'saved' })]
    });
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
      _feedback_answer: expect.arrayContaining([expect.objectContaining({ feedback: 'good', edit: 'Updated', username: 'sme@example.com' })])
    });
  });

  it('stages new records without writing them until save', async () => {
    let stored: unknown;
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    const created = await drafts.createRecord('sample-project', 'new-record');

    expect(created).toMatchObject({ recordId: 'new-record', data: {} });
    expect(stored).toBeUndefined();
    expect(drafts.getStatus('sample-project', 'new-record')).toEqual({ hasUnsavedChanges: true });

    await drafts.saveDraft('sample-project', 'new-record');

    expect(stored).toMatchObject({ _history: [expect.objectContaining({ username: 'sme@example.com', action: 'saved' })] });
    expect(drafts.getStatus('sample-project', 'new-record')).toEqual({ hasUnsavedChanges: false });
  });

  it('persists reconciled tag mutations while returning aggregate plugin warnings', async () => {
    let stored: unknown = { tags: ['manual'] };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    storage.reconcileRecordTags = async (_projectId, data) => {
      (data as { tags: string[] }).tags.push('computed');
      return { data, pluginErrors: ['broken: boom'] };
    };
    const drafts = new RecordDraftStore(() => storage);

    await drafts.updateRecord('sample-project', 'record-1', { tags: ['manual'] });
    const result = await drafts.saveDraft('sample-project', 'record-1');

    expect(stored).toMatchObject({
      tags: ['manual', 'computed'],
      _history: [expect.objectContaining({ username: 'sme@example.com', action: 'saved' })]
    });
    expect(result.record.data).toEqual({ tags: ['manual', 'computed'] });
    expect(result.tagPluginWarning).toContain('Save succeeded, but 1 tag plugin failed.');
  });

  it('computes tag mutations into the draft without persisting the record', async () => {
    let stored: unknown = { tags: ['manual'] };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });

    storage.reconcileRecordTags = async (_projectId, data) => {
      (data as { tags: string[] }).tags.push('computed');
      return { data, pluginErrors: ['broken: boom'] };
    };
    const drafts = new RecordDraftStore(() => storage);

    const result = await drafts.computeTags('sample-project', 'record-1');

    expect(stored).toEqual({ tags: ['manual'] });
    expect(result.record.data).toEqual({ tags: ['manual', 'computed'] });
    expect(result.tagPluginWarning).toContain('Tags computed, but 1 tag plugin failed.');
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });
  });

  it('appends reviewed history for queue-sourced saves without rendering history as record data', async () => {
    let stored: unknown = { answer: 'Original', _history: [{ username: 'first@example.com', timestamp: '2026-06-01T00:00:00.000Z', action: 'saved' }] };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    await drafts.updateRecord('sample-project', 'record-1', { answer: 'Reviewed' });
    const result = await drafts.saveDraft('sample-project', 'record-1', 'reviewed');

    expect(stored).toMatchObject({
      answer: 'Reviewed',
      _history: [
        { username: 'first@example.com', timestamp: '2026-06-01T00:00:00.000Z', action: 'saved' },
        expect.objectContaining({ username: 'sme@example.com', action: 'reviewed' })
      ]
    });
    expect(result.record.data).toEqual({ answer: 'Reviewed' });
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
      _feedback_answer: [{ feedback: 'fair', username: 'other@example.com', timestamp: '2026-06-02T20:00:00.000Z' }]
    };

    await expect(drafts.saveDraft('sample-project', 'record-1')).rejects.toThrow('Record changed after this draft was staged');

    expect(stored).toEqual({
      answer: 'Original',
      _feedback_answer: [{ feedback: 'fair', username: 'other@example.com', timestamp: '2026-06-02T20:00:00.000Z' }]
    });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });
  });

  it('rejects saving a draft when the persisted record changed after loading but before staging', async () => {
    let stored: unknown = { answer: 'Original' };
    const storage = createStorage(() => stored, (next) => {
      stored = next;
    });
    const drafts = new RecordDraftStore(() => storage);

    await expect(drafts.getRecord('sample-project', 'record-1')).resolves.toMatchObject({
      data: { answer: 'Original' }
    });
    stored = { answer: 'Blob edit' };
    await drafts.updateRecord('sample-project', 'record-1', { answer: 'Local edit' });

    await expect(drafts.saveDraft('sample-project', 'record-1')).rejects.toThrow('Record changed after this draft was staged');

    expect(stored).toEqual({ answer: 'Blob edit' });
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: true });
  });

  it('passes project schema saves through without staging a record draft', async () => {
    let savedSchema: unknown;
    const storage = createStorage(
      () => ({ answer: 'Original' }),
      () => undefined
    );
    storage.saveProjectSchema = async (projectId, schema) => {
      savedSchema = clone(schema);
      return { projectId, schemaPath: 'config/schema.json', backupSchemaPath: 'config/schema_1.json', schema };
    };
    const drafts = new RecordDraftStore(() => storage);
    const adapter = drafts.createStorageAdapter();
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };

    await expect(adapter.saveProjectSchema('sample-project', schema)).resolves.toEqual({
      projectId: 'sample-project',
      schemaPath: 'config/schema.json',
      backupSchemaPath: 'config/schema_1.json',
      schema
    });
    expect(savedSchema).toEqual(schema);
    expect(drafts.getStatus('sample-project', 'record-1')).toEqual({ hasUnsavedChanges: false });
  });

  it('releases the active exclusive lease before opening a different record', async () => {
    const leaseEvents: string[] = [];
    const storage = createStorage(
      () => ({ answer: 'Original' }),
      () => undefined
    );
    storage.obtainExclusiveLease = async (_projectId, recordId) => {
      leaseEvents.push(`obtain:${recordId}`);
      return { status: 'SUCCESS' };
    };
    storage.releaseExclusiveLease = async (_projectId, recordId) => {
      leaseEvents.push(`release:${recordId}`);
    };
    const drafts = new RecordDraftStore(() => storage);

    await drafts.getRecord('sample-project', 'record-1');
    await drafts.getRecord('sample-project', 'record-2');
    await drafts.releaseAll();

    expect(leaseEvents).toEqual(['obtain:record-1', 'release:record-1', 'obtain:record-2', 'release:record-2']);
  });

  it('rejects opening a record when the backend reports an exclusive lease failure', async () => {
    const storage = createStorage(
      () => ({ answer: 'Original' }),
      () => undefined
    );
    storage.obtainExclusiveLease = async () => ({ status: 'FAILURE' });
    const drafts = new RecordDraftStore(() => storage);

    await expect(drafts.getRecord('sample-project', 'record-1')).rejects.toThrow('Record is already open in another session: record-1');
  });
});

const createStorage = (read: () => unknown, write: (value: unknown) => void): StorageAdapter => ({
  listProjects: async () => [],
  createProject: async (projectId) => ({ id: projectId, name: projectId }),
  openProject: async (projectId) => ({ project: { id: projectId, name: projectId }, schema: {}, records: [], projectConfig: {} }),
  getAppPrompt: async () => undefined,
  getAppConfig: async () => ({}),
  getAppMcpConfig: async () => undefined,
  getRecord: async (projectId, recordId) => createRecordDetail(projectId, recordId, read()),
  readRecordData: async (_projectId, recordId) => {
    const value = read();
    if (value === undefined) {
      throw new Error(`Record not found: ${recordId}`);
    }
    return clone(value);
  },
  renderRecordData: async (projectId, recordId, data) => createRecordDetail(projectId, recordId, data),
  writeRecordData: async (projectId, recordId, data) => {
    write(clone(data));
    return createRecordDetail(projectId, recordId, data);
  },
  writeRecordDataIfUnchanged: async (projectId, recordId, data, expectedData) => {
    if (expectedData === undefined) {
      if (read() !== undefined) {
        throw new Error('Record changed after this draft was staged. Refresh the record, review the latest changes, and stage your edits again.');
      }
      write(clone(data));
      return createRecordDetail(projectId, recordId, data);
    }
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
        feedback: 'good_fair_bad',
        comments: false,
        editMode: 'logged'
      }
    }
  }),
  saveFeedbackConfig: async (_projectId, config) => config,
  saveProjectSchema: async (projectId, schema) => ({ projectId, schemaPath: 'config/schema.json', schema }),
  getProjectUser: async () => ({ username: 'sme@example.com', valid: true }),
  submitFeedback: async (projectId, recordId) => ({ username: 'sme@example.com', record: createRecordDetail(projectId, recordId, read()) }),
  updateRecord: async (projectId, recordId, data) => {
    write(clone(data));
    return createRecordDetail(projectId, recordId, data);
  },
  getProjectPrompt: async () => undefined,
  getProjectConfig: async () => ({}),
  getProjectMcpConfig: async () => undefined,
  getTagDefinitions: async () => [],
  reconcileRecordTags: async (_projectId, data) => ({ data, pluginErrors: [] }),
  obtainExclusiveLease: async () => ({ status: 'NOT_SUPPORTED' }),
  releaseExclusiveLease: async () => undefined,
  listQueues: async () => [],
  createQueue: async (queueName) => ({ name: queueName, messageCount: 0 }),
  deleteQueue: async () => undefined,
  clearQueue: async () => undefined,
  enqueueMessage: async () => undefined,
  dequeueMessage: async () => null,
  completeMessage: async () => undefined,
  searchRecords: async () => []
});

const createRecordDetail = (projectId: string, recordId: string, data: unknown) => {
  const stripped = stripFeedbackProperties(clone(data));
  if (stripped && typeof stripped === 'object' && !Array.isArray(stripped)) {
    delete (stripped as Record<string, unknown>)._history;
  }
  return {
    projectId,
    recordId,
    displayName: recordId,
    data: stripped,
    schema: {},
    validationIssues: [],
    renderTree: { kind: 'object' as const, label: 'record', children: [], validationIssues: [] }
  };
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
