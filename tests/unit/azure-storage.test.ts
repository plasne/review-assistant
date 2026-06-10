import { Readable } from 'node:stream';
import type { BlobServiceClient } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';
import { AzureBlobStorageAdapter } from '../../src/main/storage';

describe('azure blob storage adapter', () => {
  it('uses one container with root app config and per-project config folders', async () => {
    const blobs = new Map<string, string>([
      ['config/.env', 'USERNAME=app@example.com\n'],
      ['config/prompt.md', 'App prompt\n'],
      ['config/mcp.json', '{"mcpServers":{"app":{"command":"app-mcp"}}}\n'],
      ['config/tags.json', '[{"name":"app-tag","description":"App tag"}]\n'],
      ['sample-project/config/.env', 'USERNAME=project@example.com\n'],
      ['sample-project/config/schema.json', '{"type":"object","properties":{"answer":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}}}\n'],
      ['sample-project/config/config.json', '{"properties":{"/tags":{"path":"/tags","target":"Tags","tab":"Main","feedback":"none","comments":false,"mapping":"tags","presentation":"tags"}}}\n'],
      ['sample-project/config/tags.json', '[{"name":"project-tag","description":"Project tag"}]\n'],
      ['sample-project/record-1.json', '{"answer":"Initial","tags":[]}\n']
    ]);
    const adapter = new AzureBlobStorageAdapter(
      {
        backendKind: 'azure-connection-string',
        appEnvPath: '/unused/.env',
        values: {
          AZURE_STORAGE_ACCOUNT_CONNSTRING: 'UseDevelopmentStorage=true',
          AZURE_STORAGE_CONTAINER: 'review-assistant'
        }
      },
      createFakeBlobServiceClient(blobs)
    );

    await expect(adapter.listProjects()).resolves.toEqual([{ id: 'sample-project', name: 'sample-project' }]);
    await expect(adapter.getAppConfig()).resolves.toMatchObject({ USERNAME: 'app@example.com' });
    await expect(adapter.getAppPrompt()).resolves.toBe('App prompt\n');
    await expect(adapter.getAppMcpConfig()).resolves.toContain('"app"');
    await expect(adapter.getProjectConfig('sample-project')).resolves.toMatchObject({ USERNAME: 'project@example.com' });
    await expect(adapter.getTagDefinitions('sample-project')).resolves.toEqual([
      { name: 'project-tag', description: 'Project tag' },
      { name: 'app-tag', description: 'App tag' }
    ]);

    await adapter.createProject('new-project');
    expect(blobs.has('new-project/config/schema.json')).toBe(true);
    expect(blobs.has('new-project/config/config.json')).toBe(true);
  });
});

const createFakeBlobServiceClient = (blobs: Map<string, string>): BlobServiceClient =>
  ({
    getContainerClient: () => ({
      createIfNotExists: async () => ({ succeeded: true }),
      getBlockBlobClient: (name: string) => createFakeBlobClient(blobs, name),
      getBlobClient: (name: string) => createFakeBlobClient(blobs, name),
      listBlobsFlat: async function* (options?: { prefix?: string }) {
        for (const name of [...blobs.keys()].sort((left, right) => left.localeCompare(right))) {
          if (!options?.prefix || name.startsWith(options.prefix)) {
            yield { name };
          }
        }
      }
    })
  }) as unknown as BlobServiceClient;

const createFakeBlobClient = (blobs: Map<string, string>, name: string) => ({
  exists: async () => blobs.has(name),
  upload: async (body: string | Buffer) => {
    blobs.set(name, Buffer.isBuffer(body) ? body.toString('utf8') : body);
  },
  download: async () => ({
    readableStreamBody: Readable.from([blobs.get(name) ?? ''])
  })
});
