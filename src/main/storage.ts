import fs from 'node:fs/promises';
import path from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { AppConfig, OpenProjectResult, ProjectSummary, RecordDetail, RecordSummary } from '../shared/types';
import { assertNewProjectId, assertProjectId, assertRecordId } from '../shared/validators';
import { buildRenderTree, validateRecord } from './schema';
import { loadProjectEnv } from './env';

export interface StorageAdapter {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(projectId: string): Promise<ProjectSummary>;
  openProject(projectId: string): Promise<OpenProjectResult>;
  getRecord(projectId: string, recordId: string): Promise<RecordDetail>;
  getProjectPrompt(projectId: string): Promise<string | undefined>;
}

const NEW_PROJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: true
};

export const createStorageAdapter = (config: AppConfig): StorageAdapter => {
  if (config.backendKind === 'local') {
    return new LocalStorageAdapter(config);
  }
  return new AzureBlobStorageAdapter(config);
};

export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(private readonly config: AppConfig) {
    const localPath = config.values.LOCAL_PATH;
    if (!localPath) {
      throw new Error('LOCAL_PATH is required for local backend.');
    }
    this.root = path.resolve(localPath);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ id: entry.name, name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(projectId: string): Promise<ProjectSummary> {
    const id = assertNewProjectId(projectId);
    const project = this.projectPath(id);
    await fs.mkdir(project, { recursive: false });
    await fs.writeFile(path.join(project, '_schema.json'), `${JSON.stringify(NEW_PROJECT_SCHEMA, null, 2)}\n`, { flag: 'wx' });
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const projectConfig = loadProjectEnv(path.join(project, '.env'), this.config.values);
    const entries = await fs.readdir(project, { withFileTypes: true });
    const records = entries
      .filter((entry) => entry.isFile() && isRecordFile(entry.name))
      .map((entry): RecordSummary => ({ id: path.basename(entry.name, '.json'), displayName: path.basename(entry.name, '.json') }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { project: { id: projectId, name: projectId }, schema, records, projectConfig };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const recordPath = containedPath(project, `${id}.json`);
    const data = await readJsonFile(recordPath, `Record not found: ${id}`);
    const validationIssues = validateRecord(schema, data);
    return {
      projectId,
      recordId: id,
      displayName: id,
      data,
      schema,
      validationIssues,
      renderTree: buildRenderTree(schema, data, validationIssues)
    };
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const project = this.projectPath(assertProjectId(projectId));
    return readOptionalTextFile(path.join(project, '_prompt.txt'));
  }

  private projectPath(projectId: string): string {
    return containedPath(this.root, projectId);
  }
}

export class AzureBlobStorageAdapter implements StorageAdapter {
  private readonly client: BlobServiceClient;

  constructor(private readonly config: AppConfig) {
    if (config.backendKind === 'azure-connection-string') {
      this.client = BlobServiceClient.fromConnectionString(config.values.AZURE_STORAGE_ACCOUNT_CONNSTRING);
      return;
    }
    const accountName = config.values.AZURE_STORAGE_ACCOUNT_NAME;
    if (!accountName) {
      throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required for DefaultAzureCredential.');
    }
    this.client = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new DefaultAzureCredential());
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = [];
    for await (const container of this.client.listContainers()) {
      projects.push({ id: container.name, name: container.name });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(projectId: string): Promise<ProjectSummary> {
    const id = assertNewProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const response = await container.createIfNotExists();
    if (!response.succeeded) {
      throw new Error(`Project already exists: ${id}`);
    }
    const schema = JSON.stringify(NEW_PROJECT_SCHEMA, null, 2);
    await container.getBlockBlobClient('_schema.json').upload(schema, Buffer.byteLength(schema));
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schemaText = await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.');
    const schema = JSON.parse(schemaText) as unknown;
    const projectEnv = await this.readOptionalBlob(container, '.env');
    const projectConfig = projectEnv ? { ...this.config.values, ...parseAzureProjectEnv(projectEnv) } : this.config.values;
    const records: RecordSummary[] = [];
    for await (const blob of container.listBlobsFlat()) {
      if (isRecordFile(blob.name)) {
        const recordId = blob.name.slice(0, -'.json'.length);
        records.push({ id: recordId, displayName: recordId });
      }
    }
    return { project: { id, name: id }, schema, records: records.sort((a, b) => a.displayName.localeCompare(b.displayName)), projectConfig };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    const data = JSON.parse(await this.readBlob(container, `${record}.json`, `Record not found: ${record}`)) as unknown;
    const validationIssues = validateRecord(schema, data);
    return {
      projectId: id,
      recordId: record,
      displayName: record,
      data,
      schema,
      validationIssues,
      renderTree: buildRenderTree(schema, data, validationIssues)
    };
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const id = assertProjectId(projectId);
    return this.readOptionalBlob(this.client.getContainerClient(id), '_prompt.txt');
  }

  private async readBlob(container: ReturnType<BlobServiceClient['getContainerClient']>, name: string, missingMessage: string): Promise<string> {
    const blob = container.getBlobClient(name);
    if (!(await blob.exists())) {
      throw new Error(missingMessage);
    }
    const response = await blob.download();
    return streamToString(response.readableStreamBody);
  }

  private async readOptionalBlob(container: ReturnType<BlobServiceClient['getContainerClient']>, name: string): Promise<string | undefined> {
    const blob = container.getBlobClient(name);
    if (!(await blob.exists())) {
      return undefined;
    }
    const response = await blob.download();
    return streamToString(response.readableStreamBody);
  }
}

const isRecordFile = (name: string): boolean => name.endsWith('.json') && !path.basename(name).startsWith('_') && !name.includes('/');

const containedPath = (root: string, child: string): string => {
  const resolved = path.resolve(root, child);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes configured project root.');
  }
  return resolved;
};

const readJsonFile = async (filePath: string, missingMessage: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(missingMessage);
    }
    throw error;
  }
};

const readOptionalTextFile = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const streamToString = async (stream: NodeJS.ReadableStream | undefined): Promise<string> => {
  if (!stream) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const parseAzureProjectEnv = (content: string): Record<string, string> =>
  Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        if (index <= 0) {
          throw new Error(`Invalid project .env line: ${line}`);
        }
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
