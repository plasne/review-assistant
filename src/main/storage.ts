import fs from 'node:fs/promises';
import path from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  AppConfig,
  FeedbackConfig,
  FeedbackSubmissionInput,
  FeedbackSubmissionResult,
  OpenProjectResult,
  ProjectSummary,
  ProjectUser,
  RecordDetail,
  RecordSummary
} from '../shared/types';
import {
  assertFeedbackSubmissionInput as assertNonEmptyFeedbackSubmission,
  deriveFeedbackTargets,
  extractFeedbackHistory,
  feedbackConfigEntryForPath,
  getProjectUser,
  mergeFeedbackEntries,
  normalizeFeedbackConfig,
  stripFeedbackProperties
} from '../shared/feedback';
import { assertNewProjectId, assertProjectId, assertRecordId } from '../shared/validators';
import { buildRenderTree, validateRecord } from './schema';
import { loadProjectEnv, readEnvFile } from './env';

export interface StorageAdapter {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(projectId: string): Promise<ProjectSummary>;
  openProject(projectId: string): Promise<OpenProjectResult>;
  getRecord(projectId: string, recordId: string): Promise<RecordDetail>;
  getFeedbackConfig(projectId: string): Promise<FeedbackConfig>;
  saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig>;
  getProjectUser(projectId: string): Promise<ProjectUser>;
  submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult>;
  updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  getProjectPrompt(projectId: string): Promise<string | undefined>;
}

const NEW_PROJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: true
};
const BACKEND_KEYS = new Set(['AZURE_STORAGE_ACCOUNT_CONNSTRING', 'AZURE_STORAGE_ACCOUNT_NAME', 'LOCAL_PATH']);

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
    await fs.writeFile(path.join(project, '_feedback.json'), `${JSON.stringify(normalizeFeedbackConfig(NEW_PROJECT_SCHEMA, undefined), null, 2)}\n`, {
      flag: 'wx'
    });
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const projectConfig = this.loadProjectConfig(project);
    const feedbackConfig = await this.readFeedbackConfig(project, schema);
    const entries = await fs.readdir(project, { withFileTypes: true });
    const records = entries
      .filter((entry) => entry.isFile() && isRecordFile(entry.name))
      .map((entry): RecordSummary => ({ id: path.basename(entry.name, '.json'), displayName: path.basename(entry.name, '.json') }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { project: { id: projectId, name: projectId }, schema, records, projectConfig, feedbackConfig };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const recordPath = containedPath(project, `${id}.json`);
    const data = await readJsonFile(recordPath, `Record not found: ${id}`);
    return buildRecordDetail(projectId, id, schema, data);
  }

  async getFeedbackConfig(projectId: string): Promise<FeedbackConfig> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    return this.readFeedbackConfig(project, schema);
  }

  async saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const normalized = normalizeFeedbackConfig(schema, config);
    await writeJsonFile(path.join(project, '_feedback.json'), normalized);
    return normalized;
  }

  async getProjectUser(projectId: string): Promise<ProjectUser> {
    const project = this.projectPath(assertProjectId(projectId));
    return getProjectUser(this.loadProjectConfig(project, { log: false }));
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const config = await this.readFeedbackConfig(project, schema);
    assertSubmissionAllowed(config, validInput);
    const user = getProjectUser(this.loadProjectConfig(project));
    if (!user.valid || !user.username) {
      throw new Error(user.validationMessage);
    }
    const recordPath = containedPath(project, `${id}.json`);
    const data = await readJsonFile(recordPath, `Record not found: ${id}`);
    if (!isPlainRecord(data)) {
      throw new Error('Feedback can only be added to object records.');
    }
    mergeFeedbackEntries(data, validInput, user.username);
    await writeJsonFile(recordPath, data);
    return { username: user.username, record: buildRecordDetail(projectId, id, schema, data) };
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const schema = await readJsonFile(path.join(project, '_schema.json'), 'Project is missing required _schema.json.');
    const recordPath = containedPath(project, `${id}.json`);
    const existing = await readJsonFile(recordPath, `Record not found: ${id}`);
    const feedback = isPlainRecord(existing)
      ? Object.fromEntries(Object.entries(existing).filter(([key]) => key.endsWith('_feedback') || key.endsWith('_edits') || key.endsWith('_comments')))
      : {};
    const next = isPlainRecord(data) ? { ...data, ...feedback } : data;
    await writeJsonFile(recordPath, next);
    return buildRecordDetail(projectId, id, schema, next);
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const project = this.projectPath(assertProjectId(projectId));
    return readOptionalTextFile(path.join(project, '_prompt.txt'));
  }

  private projectPath(projectId: string): string {
    return containedPath(this.root, projectId);
  }

  private loadProjectConfig(project: string, options?: { log?: boolean }): Record<string, string> {
    return loadProjectEnv(path.join(project, '.env'), { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath) }, options);
  }

  private async readFeedbackConfig(project: string, schema: unknown): Promise<FeedbackConfig> {
    const config = await readOptionalJsonFile(path.join(project, '_feedback.json'));
    return normalizeFeedbackConfig(schema, config);
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
    const feedbackConfig = JSON.stringify(normalizeFeedbackConfig(NEW_PROJECT_SCHEMA, undefined), null, 2);
    await container.getBlockBlobClient('_feedback.json').upload(feedbackConfig, Buffer.byteLength(feedbackConfig));
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schemaText = await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.');
    const schema = JSON.parse(schemaText) as unknown;
    const projectEnv = await this.readOptionalBlob(container, '.env');
    const projectConfig = this.mergeAzureProjectConfig(projectEnv);
    const feedbackConfig = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, '_feedback.json'));
    const records: RecordSummary[] = [];
    for await (const blob of container.listBlobsFlat()) {
      if (isRecordFile(blob.name)) {
        const recordId = blob.name.slice(0, -'.json'.length);
        records.push({ id: recordId, displayName: recordId });
      }
    }
    return { project: { id, name: id }, schema, records: records.sort((a, b) => a.displayName.localeCompare(b.displayName)), projectConfig, feedbackConfig };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    const data = JSON.parse(await this.readBlob(container, `${record}.json`, `Record not found: ${record}`)) as unknown;
    return buildRecordDetail(id, record, schema, data);
  }

  async getFeedbackConfig(projectId: string): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    return normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, '_feedback.json'));
  }

  async saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    const normalized = normalizeFeedbackConfig(schema, config);
    const body = `${JSON.stringify(normalized, null, 2)}\n`;
    await container.getBlockBlobClient('_feedback.json').upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return normalized;
  }

  async getProjectUser(projectId: string): Promise<ProjectUser> {
    const id = assertProjectId(projectId);
    const projectEnv = await this.readOptionalBlob(this.client.getContainerClient(id), '.env');
    return getProjectUser(this.mergeAzureProjectConfig(projectEnv));
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    const config = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, '_feedback.json'));
    assertSubmissionAllowed(config, validInput);
    const user = getProjectUser(this.mergeAzureProjectConfig(await this.readOptionalBlob(container, '.env')));
    if (!user.valid || !user.username) {
      throw new Error(user.validationMessage);
    }
    const blob = container.getBlockBlobClient(`${record}.json`);
    const data = JSON.parse(await this.readBlob(container, `${record}.json`, `Record not found: ${record}`)) as unknown;
    if (!isPlainRecord(data)) {
      throw new Error('Feedback can only be added to object records.');
    }
    mergeFeedbackEntries(data, validInput, user.username);
    const body = `${JSON.stringify(data, null, 2)}\n`;
    await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return { username: user.username, record: buildRecordDetail(id, record, schema, data) };
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readBlob(container, '_schema.json', 'Project is missing required _schema.json.')) as unknown;
    const existing = JSON.parse(await this.readBlob(container, `${record}.json`, `Record not found: ${record}`)) as unknown;
    const feedback = isPlainRecord(existing)
      ? Object.fromEntries(Object.entries(existing).filter(([key]) => key.endsWith('_feedback') || key.endsWith('_edits') || key.endsWith('_comments')))
      : {};
    const next = isPlainRecord(data) ? { ...data, ...feedback } : data;
    const body = `${JSON.stringify(next, null, 2)}\n`;
    await container.getBlockBlobClient(`${record}.json`).upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return buildRecordDetail(id, record, schema, next);
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

  private async readOptionalJsonBlob(container: ReturnType<BlobServiceClient['getContainerClient']>, name: string): Promise<unknown> {
    const content = await this.readOptionalBlob(container, name);
    return content ? (JSON.parse(content) as unknown) : undefined;
  }

  private mergeAzureProjectConfig(projectEnv: string | undefined): Record<string, string> {
    return projectEnv
      ? { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath), ...parseAzureProjectEnv(projectEnv) }
      : { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath) };
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

const readOptionalJsonFile = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const readRuntimeEnvValues = (envPath: string): Record<string, string> =>
  Object.fromEntries(Object.entries(readEnvFile(envPath)).filter(([key]) => !BACKEND_KEYS.has(key)));

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

const buildRecordDetail = (projectId: string, recordId: string, schema: unknown, data: unknown): RecordDetail => {
  const coreData = stripFeedbackProperties(data);
  const validationIssues = validateRecord(schema, coreData);
  return {
    projectId,
    recordId,
    displayName: recordId,
    data: coreData,
    schema,
    validationIssues,
    renderTree: buildRenderTree(schema, coreData, validationIssues),
    feedbackHistory: extractFeedbackHistory(data, deriveFeedbackTargets(schema))
  };
};

const assertSubmissionAllowed = (config: FeedbackConfig, input: FeedbackSubmissionInput): void => {
  const entry = feedbackConfigEntryForPath(config, input.propertyPath);
  if (!entry) {
    throw new Error('Feedback target is not present in the project schema.');
  }
  if (input.feedbackValue?.trim() && entry.feedback === 'none') {
    throw new Error('Feedback is not configured for this property.');
  }
  if (input.commentValue?.trim() && !entry.comments) {
    throw new Error('SME comments are not enabled for this property.');
  }
  if (input.editValue?.trim() && !entry.editable) {
    throw new Error('Edits are not enabled for this property.');
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
