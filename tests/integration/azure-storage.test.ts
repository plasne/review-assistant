import { BlobServiceClient } from '@azure/storage-blob';
import { QueueServiceClient } from '@azure/storage-queue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordDraftStore } from '../../src/main/drafts';
import { AzureBlobStorageAdapter, RECORD_DRAFT_CONFLICT_MESSAGE } from '../../src/main/storage';

const connectionString = 'UseDevelopmentStorage=true';
const client = BlobServiceClient.fromConnectionString(connectionString);
const queueServiceClient = QueueServiceClient.fromConnectionString(connectionString);

describe('azure blob storage adapter with Azurite', () => {
  let containerName: string;
  let adapter: AzureBlobStorageAdapter;

  beforeEach(async () => {
    containerName = `ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    adapter = new AzureBlobStorageAdapter({
      backendKind: 'azure-connection-string',
      appEnvPath: '/unused/config/.env',
      values: {
        AZURE_STORAGE_ACCOUNT_CONNSTRING: connectionString,
        AZURE_STORAGE_CONTAINER: containerName,
        USERNAME: 'sme@example.com'
      }
    });
    await client.getContainerClient(containerName).create();
  });

  afterEach(async () => {
    await client.getContainerClient(containerName).deleteIfExists();
  });

  it('loads app and project config from one container and updates records through real blob APIs', async () => {
    await uploadText('config/.env', 'USERNAME=app@example.com\n');
    await uploadText('config/prompt.md', 'App prompt\n');
    await uploadText('config/mcp.json', '{"mcpServers":{"app":{"command":"app-mcp"}}}\n');
    await uploadText('config/tags.json', '[{"name":"app-tag","description":"App tag"}]\n');
    await uploadText('sample-project/config/.env', 'USERNAME="project@example.com"\nSOURCE_TOKEN=secret\n');
    await uploadText(
      'sample-project/config/schema.json',
      JSON.stringify({
        type: 'object',
        properties: {
          answer: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        }
      })
    );
    await uploadText(
      'sample-project/config/config.json',
      JSON.stringify({
        properties: {
          '/answer': {
            path: '/answer',
            target: 'Answer',
            tab: 'Main',
            feedback: 'good_fair_bad',
            comments: true,
            edit_mode: 'logged'
          },
          '/tags': {
            path: '/tags',
            target: 'Tags',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            mapping: 'tags',
            presentation: 'tags'
          }
        }
      })
    );
    await uploadText('sample-project/config/tags.json', '[{"name":"project-tag","description":"Project tag"}]\n');
    await uploadText('sample-project/record-1.json', '{"answer":"Initial","tags":[]}\n');

    await expect(adapter.listProjects()).resolves.toEqual([{ id: 'sample-project', name: 'sample-project' }]);
    await expect(adapter.getAppConfig()).resolves.toMatchObject({ USERNAME: 'app@example.com' });
    await expect(adapter.getAppPrompt()).resolves.toBe('App prompt\n');
    await expect(adapter.getAppMcpConfig()).resolves.toContain('"app"');
    await expect(adapter.getProjectConfig('sample-project')).resolves.toMatchObject({
      USERNAME: 'project@example.com',
      SOURCE_TOKEN: 'secret'
    });
    await expect(adapter.openProject('sample-project')).resolves.toMatchObject({
      projectConfig: { USERNAME: 'project@example.com', SOURCE_TOKEN: '****' },
      records: [{ id: 'record-1', displayName: 'record-1' }],
      tagDefinitions: [
        { name: 'project-tag', description: 'Project tag' },
        { name: 'app-tag', description: 'App tag' }
      ]
    });

    const submitted = await adapter.submitFeedback('sample-project', 'record-1', {
      propertyPath: '/answer',
      feedbackValue: 'good',
      commentValue: 'Clear',
      editValue: 'Updated'
    });
    expect(submitted.username).toBe('project@example.com');
    expect(submitted.record.data).toEqual({ answer: 'Updated', tags: [] });

    const updated = await adapter.updateRecord('sample-project', 'record-1', { answer: 'Core update', tags: ['project-tag'] });
    expect(updated.data).toEqual({ answer: 'Core update', tags: ['project-tag'] });
    expect(updated.feedbackHistory?.['/answer'].comments[0]).toMatchObject({ value: 'Clear', username: 'project@example.com' });
  });

  it('creates queues, searches tagged records, and completes dequeued messages', async () => {
    await adapter.createProject('queue-project');
    await uploadText(
      'queue-project/config/config.json',
      JSON.stringify({
        properties: {
          '/tags': {
            path: '/tags',
            target: 'Tags',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            mapping: 'tags',
            presentation: 'tags'
          }
        }
      })
    );
    await uploadText('queue-project/record-1.json', '{"answer":"One","tags":["needs-review","complex-query"]}\n');
    await uploadText('queue-project/record-2.json', '{"answer":"Two","tags":["approved","multi-turn"]}\n');
    const queueName = `raqueue${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

    await expect(adapter.createQueue(queueName)).resolves.toMatchObject({ name: queueName, messageCount: 0 });
    await expect(adapter.listProjectTags('queue-project')).resolves.toEqual(['approved', 'complex-query', 'multi-turn', 'needs-review']);
    await expect(adapter.searchRecords('queue-project', { included: ['needs-review'], excluded: [] })).resolves.toEqual([
      { id: 'record-1', displayName: 'record-1' }
    ]);
    await adapter.enqueueMessage(queueName, { project: 'queue-project', filename: 'record-1', instructions: 'Check evidence.' });

    const dequeued = await adapter.dequeueMessage(queueName);
    expect(dequeued).toMatchObject({
      message: { project: 'queue-project', filename: 'record-1', instructions: 'Check evidence.' }
    });
    expect(dequeued?.popReceipt).toEqual(expect.any(String));
    await adapter.completeMessage(queueName, dequeued?.popReceipt ?? '');
    await expect(adapter.dequeueMessage(queueName)).resolves.toBeNull();
    await queueServiceClient.getQueueClient(queueName).deleteIfExists();
  });

  it('uses blob conditions for new draft creates and rotates schema backups', async () => {
    await adapter.createProject('draft-project');
    await expect(adapter.createProject('draft-project')).rejects.toThrow('Project already exists: draft-project');

    const saved = await adapter.writeRecordDataIfUnchanged('draft-project', 'record-1', { answer: 'Draft' }, undefined);
    expect(saved.data).toEqual({ answer: 'Draft' });
    await expect(adapter.writeRecordDataIfUnchanged('draft-project', 'record-1', { answer: 'Overwrite' }, undefined)).rejects.toThrow(
      RECORD_DRAFT_CONFLICT_MESSAGE
    );
    const updated = await adapter.writeRecordDataIfUnchanged('draft-project', 'record-1', { answer: 'Updated draft' }, { answer: 'Draft' });
    expect(updated.data).toEqual({ answer: 'Updated draft' });

    const firstSchema = { type: 'object', properties: { answer: { type: 'string' } } };
    const secondSchema = { type: 'object', properties: { score: { type: 'number' } } };
    await uploadText('draft-project/config/schema_1.json', '{"type":"object","properties":{"reserved":{"type":"string"}}}\n');
    await expect(adapter.saveProjectSchema('draft-project', firstSchema)).resolves.toMatchObject({
      backupSchemaPath: 'config/schema_2.json'
    });
    await expect(adapter.saveProjectSchema('draft-project', secondSchema)).resolves.toMatchObject({
      backupSchemaPath: 'config/schema_3.json'
    });
    await expect(downloadJson('draft-project/config/schema_1.json')).resolves.toMatchObject({
      type: 'object',
      properties: { reserved: { type: 'string' } }
    });
    await expect(downloadJson('draft-project/config/schema_2.json')).resolves.toMatchObject({
      type: 'object',
      additionalProperties: true
    });
    await expect(downloadJson('draft-project/config/schema_3.json')).resolves.toEqual(firstSchema);
  });

  it('rejects a stale draft when a blob changes after the record is loaded', async () => {
    await adapter.createProject('etag-project');
    await uploadText('etag-project/record-1.json', '{"answer":"Loaded"}\n');
    const drafts = new RecordDraftStore(() => adapter);

    await expect(drafts.getRecord('etag-project', 'record-1')).resolves.toMatchObject({
      data: { answer: 'Loaded' }
    });
    await adapter.releaseExclusiveLease('etag-project', 'record-1');
    await uploadText('etag-project/record-1.json', '{"answer":"Blob edit"}\n');
    await drafts.updateRecord('etag-project', 'record-1', { answer: 'Local edit' });

    await expect(drafts.saveDraft('etag-project', 'record-1')).rejects.toThrow(RECORD_DRAFT_CONFLICT_MESSAGE);
    await expect(downloadJson('etag-project/record-1.json')).resolves.toEqual({ answer: 'Blob edit' });
  });

  it('obtains an Azure blob lease, blocks competing leases, and releases it', async () => {
    await adapter.createProject('lease-project');
    await uploadText('lease-project/record-1.json', '{"answer":"Unlocked"}\n');
    const competingAdapter = new AzureBlobStorageAdapter({
      backendKind: 'azure-connection-string',
      appEnvPath: '/unused/config/.env',
      values: {
        AZURE_STORAGE_ACCOUNT_CONNSTRING: connectionString,
        AZURE_STORAGE_CONTAINER: containerName
      }
    });

    await expect(adapter.obtainExclusiveLease('lease-project', 'record-1')).resolves.toEqual({ status: 'SUCCESS' });
    await expect(competingAdapter.obtainExclusiveLease('lease-project', 'record-1')).resolves.toEqual({ status: 'FAILURE' });
    await expect(adapter.writeRecordData('lease-project', 'record-1', { answer: 'Holder update' })).resolves.toMatchObject({
      data: { answer: 'Holder update' }
    });

    await adapter.releaseExclusiveLease('lease-project', 'record-1');

    await expect(competingAdapter.obtainExclusiveLease('lease-project', 'record-1')).resolves.toEqual({ status: 'SUCCESS' });
    await competingAdapter.releaseExclusiveLease('lease-project', 'record-1');
  });

  it('releases the current Azure blob lease when the draft store opens another record', async () => {
    await adapter.createProject('lease-switch-project');
    await uploadText('lease-switch-project/record-1.json', '{"answer":"One"}\n');
    await uploadText('lease-switch-project/record-2.json', '{"answer":"Two"}\n');
    const drafts = new RecordDraftStore(() => adapter);
    const competingAdapter = new AzureBlobStorageAdapter({
      backendKind: 'azure-connection-string',
      appEnvPath: '/unused/config/.env',
      values: {
        AZURE_STORAGE_ACCOUNT_CONNSTRING: connectionString,
        AZURE_STORAGE_CONTAINER: containerName
      }
    });

    await drafts.getRecord('lease-switch-project', 'record-1');
    await expect(competingAdapter.obtainExclusiveLease('lease-switch-project', 'record-1')).resolves.toEqual({ status: 'FAILURE' });
    await drafts.getRecord('lease-switch-project', 'record-2');

    await expect(competingAdapter.obtainExclusiveLease('lease-switch-project', 'record-1')).resolves.toEqual({ status: 'SUCCESS' });
    await competingAdapter.releaseExclusiveLease('lease-switch-project', 'record-1');
    await drafts.releaseAll();
  });

  it('rejects a stale draft when a blob changes and later returns to the loaded content', async () => {
    await adapter.createProject('etag-roundtrip-project');
    await uploadText('etag-roundtrip-project/record-1.json', '{"answer":"Loaded"}\n');
    const drafts = new RecordDraftStore(() => adapter);

    await expect(drafts.getRecord('etag-roundtrip-project', 'record-1')).resolves.toMatchObject({
      data: { answer: 'Loaded' }
    });
    await adapter.releaseExclusiveLease('etag-roundtrip-project', 'record-1');
    await uploadText('etag-roundtrip-project/record-1.json', '{"answer":"Blob edit"}\n');
    await uploadText('etag-roundtrip-project/record-1.json', '{"answer":"Loaded"}\n');
    await drafts.updateRecord('etag-roundtrip-project', 'record-1', { answer: 'Local edit' });

    await expect(drafts.saveDraft('etag-roundtrip-project', 'record-1')).rejects.toThrow(RECORD_DRAFT_CONFLICT_MESSAGE);
    await expect(downloadJson('etag-roundtrip-project/record-1.json')).resolves.toEqual({ answer: 'Loaded' });
  });

  it('rejects a schema save when the blob changed after the schema was loaded', async () => {
    await adapter.createProject('schema-etag-project');
    const loadedSchema = (await adapter.openProject('schema-etag-project')).schema;
    await uploadText('schema-etag-project/config/schema.json', '{"type":"object","properties":{"blob":{"type":"string"}}}\n');

    await expect(
      adapter.saveProjectSchema('schema-etag-project', { type: 'object', properties: { local: { type: 'string' } } }, loadedSchema)
    ).rejects.toThrow('Project schema changed while saving');
    await expect(downloadJson('schema-etag-project/config/schema.json')).resolves.toEqual({
      type: 'object',
      properties: { blob: { type: 'string' } }
    });
  });

  it('rejects a schema save when the blob changes and later returns to the loaded schema', async () => {
    await adapter.createProject('schema-etag-roundtrip-project');
    const loadedSchema = (await adapter.openProject('schema-etag-roundtrip-project')).schema;
    await uploadText('schema-etag-roundtrip-project/config/schema.json', '{"type":"object","properties":{"blob":{"type":"string"}}}\n');
    await uploadText('schema-etag-roundtrip-project/config/schema.json', `${JSON.stringify(loadedSchema, null, 2)}\n`);

    await expect(
      adapter.saveProjectSchema('schema-etag-roundtrip-project', { type: 'object', properties: { local: { type: 'string' } } }, loadedSchema)
    ).rejects.toThrow('Project schema changed while saving');
    await expect(downloadJson('schema-etag-roundtrip-project/config/schema.json')).resolves.toEqual(loadedSchema);
  });

  it('rejects backend selection overrides in blob-backed app and project env files', async () => {
    await uploadText('config/.env', 'AZURE_STORAGE_CONTAINER=other\n');
    await expect(adapter.getAppConfig()).rejects.toThrow('app config/.env cannot override backend selection keys: AZURE_STORAGE_CONTAINER');

    await client.getContainerClient(containerName).deleteBlob('config/.env');
    await uploadText('config/.env', 'invalid-name=value\n');
    await expect(adapter.getAppConfig()).rejects.toThrow('Invalid app config/.env variable name: invalid-name');

    await client.getContainerClient(containerName).deleteBlob('config/.env');
    await adapter.createProject('env-project');
    await uploadText('env-project/config/.env', 'LOCAL_PATH=/tmp/projects\n');

    await expect(adapter.openProject('env-project')).rejects.toThrow('project config/.env cannot override backend selection keys: LOCAL_PATH');
  });

  const uploadText = async (name: string, content: string): Promise<void> => {
    await client
      .getContainerClient(containerName)
      .getBlockBlobClient(name)
      .upload(content, Buffer.byteLength(content), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  };

  const downloadJson = async (name: string): Promise<unknown> => {
    const response = await client.getContainerClient(containerName).getBlobClient(name).download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody ?? []) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
});
