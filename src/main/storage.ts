import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants, lstatSync } from 'node:fs';
import path from 'node:path';
import { BlobServiceClient, type BlobLeaseClient } from '@azure/storage-blob';
import { QueueServiceClient, type QueueClient } from '@azure/storage-queue';
import { DefaultAzureCredential } from '@azure/identity';
import type {
  AppConfig,
  DequeueResult,
  FeedbackConfig,
  FeedbackSubmissionInput,
  FeedbackSubmissionResult,
  HistoryEntry,
  OpenProjectResult,
  ProjectSummary,
  ProjectUser,
  QueueInfo,
  QueueMessage,
  RecordDetail,
  RecordSummary,
  TagFilter
} from '../shared/types';
import {
  assertFeedbackSubmissionInput as assertNonEmptyFeedbackSubmission,
  deriveFeedbackTargets,
  extractFeedbackHistory,
  feedbackConfigEntryForPath,
  getProjectUser,
  mergeFeedbackEntries,
  normalizeFeedbackConfig,
  stripFeedbackProperties,
  toPersistedFeedbackConfig
} from '../shared/feedback';
import { assertNewProjectId, assertProjectId, assertQueueName, assertRecordId } from '../shared/validators';
import { buildRenderTree, validateRecord } from './schema';
import { loadProjectEnv, readEnvFile, redactConfig } from './env';
import { logError } from '../shared/logging';
import {
  discoverComputedTagPlugins,
  loadManualTagDefinitionsFromDirectories,
  loadManualTagDefinitionsFromValues,
  reconcileComputedTags,
  tagsMappingPath,
  type ReconcileTagsResult
} from './tags';

export interface StorageAdapter {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(projectId: string): Promise<ProjectSummary>;
  openProject(projectId: string): Promise<OpenProjectResult>;
  getAppPrompt(): Promise<string | undefined>;
  getAppConfig(): Promise<Record<string, string>>;
  getAppMcpConfig(): Promise<string | undefined>;
  getRecord(projectId: string, recordId: string): Promise<RecordDetail>;
  readRecordData?(projectId: string, recordId: string): Promise<unknown>;
  renderRecordData?(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  writeRecordData?(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  writeRecordDataIfUnchanged?(projectId: string, recordId: string, data: unknown, expectedData: unknown): Promise<RecordDetail>;
  getFeedbackConfig(projectId: string): Promise<FeedbackConfig>;
  saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig>;
  saveProjectSchema(projectId: string, schema: unknown, expectedSchema?: unknown): Promise<ProjectSchemaSaveResult>;
  getProjectUser(projectId: string): Promise<ProjectUser>;
  submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult>;
  updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  getProjectPrompt(projectId: string): Promise<string | undefined>;
  getProjectConfig(projectId: string): Promise<Record<string, string>>;
  getProjectMcpConfig(projectId: string): Promise<string | undefined>;
  getTagDefinitions(projectId: string): Promise<import('../shared/types').TagDefinition[]>;
  listProjectTags?(projectId: string): Promise<string[]>;
  reconcileRecordTags(projectId: string, data: unknown): Promise<ReconcileTagsResult>;
  obtainExclusiveLease(projectId: string, recordId: string): Promise<ExclusiveLeaseResult>;
  releaseExclusiveLease(projectId: string, recordId: string): Promise<void>;
  listQueues(): Promise<QueueInfo[]>;
  createQueue(queueName: string): Promise<QueueInfo>;
  deleteQueue(queueName: string): Promise<void>;
  clearQueue(queueName: string): Promise<void>;
  enqueueMessage(queueName: string, message: QueueMessage): Promise<void>;
  dequeueMessage(queueName: string): Promise<DequeueResult | null>;
  completeMessage(queueName: string, popReceipt: string): Promise<void>;
  searchRecords(projectId: string, tagFilter: TagFilter): Promise<RecordSummary[]>;
}

export type ExclusiveLeaseStatus = 'SUCCESS' | 'FAILURE' | 'NOT_SUPPORTED';

export type ExclusiveLeaseResult = {
  status: ExclusiveLeaseStatus;
};

export type ProjectSchemaSaveResult = {
  projectId: string;
  schemaPath: string;
  backupSchemaPath?: string;
  schema: unknown;
};

const NEW_PROJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: true
};
export const RECORD_DRAFT_CONFLICT_MESSAGE =
  'Record changed after this draft was staged. Refresh the record, review the latest changes, and stage your edits again.';
const BACKEND_KEYS = new Set(['AZURE_STORAGE_ACCOUNT_CONNSTRING', 'AZURE_STORAGE_ACCOUNT_NAME', 'AZURE_STORAGE_CONTAINER', 'LOCAL_PATH']);
const CONFIG_DIRECTORY = 'config';
const PROJECT_CONFIG_FILE = `${CONFIG_DIRECTORY}/config.json`;
const PROJECT_ENV_FILE = `${CONFIG_DIRECTORY}/.env`;
const PROJECT_MCP_FILE = `${CONFIG_DIRECTORY}/mcp.json`;
const PROJECT_PROMPT_FILE = `${CONFIG_DIRECTORY}/prompt.md`;
const PROJECT_SCHEMA_FILE = `${CONFIG_DIRECTORY}/schema.json`;
const PROJECT_TAGS_FILE = `${CONFIG_DIRECTORY}/tags.json`;

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
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== CONFIG_DIRECTORY)
      .map((entry) => ({ id: entry.name, name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(projectId: string): Promise<ProjectSummary> {
    const id = assertNewProjectId(projectId);
    const project = this.projectPath(id);
    await fs.mkdir(project, { recursive: false });
    await fs.mkdir(path.join(project, CONFIG_DIRECTORY), { recursive: false });
    await fs.writeFile(path.join(project, PROJECT_SCHEMA_FILE), `${JSON.stringify(NEW_PROJECT_SCHEMA, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(project, PROJECT_CONFIG_FILE), `${JSON.stringify(toPersistedFeedbackConfig(normalizeFeedbackConfig(NEW_PROJECT_SCHEMA, undefined)), null, 2)}\n`, {
      flag: 'wx'
    });
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await this.readProjectSchema(project);
    const projectConfig = redactConfig(this.loadProjectConfig(project));
    const feedbackConfig = await this.readFeedbackConfig(project, schema);
    const tagDefinitions = await this.getTagDefinitions(projectId);
    const entries = await fs.readdir(project, { withFileTypes: true });
    const records = entries
      .filter((entry) => entry.isFile() && isRecordFile(entry.name))
      .map((entry): RecordSummary => ({ id: path.basename(entry.name, '.json'), displayName: path.basename(entry.name, '.json') }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { project: { id: projectId, name: projectId }, schema, records, projectConfig, feedbackConfig, tagDefinitions };
  }

  async getAppPrompt(): Promise<string | undefined> {
    return readOptionalTextFile(path.join(this.appConfigPath(), 'prompt.md'));
  }

  async getAppConfig(): Promise<Record<string, string>> {
    return { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath) };
  }

  async getAppMcpConfig(): Promise<string | undefined> {
    return readOptionalTextFile(path.join(this.appConfigPath(), 'mcp.json'));
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    return this.renderRecordData(projectId, recordId, await this.readRecordData(projectId, recordId));
  }

  async obtainExclusiveLease(_projectId: string, _recordId: string): Promise<ExclusiveLeaseResult> {
    return { status: 'NOT_SUPPORTED' };
  }

  async releaseExclusiveLease(_projectId: string, _recordId: string): Promise<void> {
    return undefined;
  }

  async listQueues(): Promise<QueueInfo[]> {
    return [];
  }

  async createQueue(_queueName: string): Promise<QueueInfo> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async deleteQueue(_queueName: string): Promise<void> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async clearQueue(_queueName: string): Promise<void> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async enqueueMessage(_queueName: string, _message: QueueMessage): Promise<void> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async dequeueMessage(_queueName: string): Promise<DequeueResult | null> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async completeMessage(_queueName: string, _popReceipt: string): Promise<void> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async searchRecords(_projectId: string, _tagFilter: TagFilter): Promise<RecordSummary[]> {
    throw new Error(QUEUES_UNSUPPORTED_MESSAGE);
  }

  async readRecordData(projectId: string, recordId: string): Promise<unknown> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const recordPath = containedPath(project, `${id}.json`);
    return readJsonFile(recordPath, `Record not found: ${id}`);
  }

  async renderRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const schema = await this.readProjectSchema(project);
    return buildRecordDetail(projectId, id, schema, data, await this.readFeedbackConfig(project, schema));
  }

  async writeRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    await writeJsonFile(containedPath(project, `${id}.json`), data);
    return this.renderRecordData(projectId, id, data);
  }

  async writeRecordDataIfUnchanged(projectId: string, recordId: string, data: unknown, expectedData: unknown): Promise<RecordDetail> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const recordPath = containedPath(project, `${id}.json`);
    if (expectedData === undefined) {
      try {
        await fs.writeFile(recordPath, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
        }
        throw error;
      }
      return this.renderRecordData(projectId, id, data);
    }
    const current = await readJsonFile(recordPath, `Record not found: ${id}`);
    if (!jsonEqual(current, expectedData)) {
      throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
    }
    await writeJsonFile(recordPath, data);
    return this.renderRecordData(projectId, id, data);
  }

  async getFeedbackConfig(projectId: string): Promise<FeedbackConfig> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await this.readProjectSchema(project);
    return this.readFeedbackConfig(project, schema);
  }

  async saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await this.readProjectSchema(project);
    const normalized = normalizeFeedbackConfig(schema, config);
    const configPath = await this.projectConfigFilePath(project, 'config.json');
    await rejectSymlinkIfExists(configPath, PROJECT_CONFIG_FILE);
    await writeJsonFile(configPath, toPersistedFeedbackConfig(normalized));
    return normalized;
  }

  async saveProjectSchema(projectId: string, schema: unknown, expectedSchema?: unknown): Promise<ProjectSchemaSaveResult> {
    const id = assertProjectId(projectId);
    const project = this.projectPath(id);
    const configPath = await this.projectConfigDirectoryPath(project);
    await fs.mkdir(configPath, { recursive: true });
    await this.projectConfigDirectoryPath(project);
    const schemaPath = await this.projectConfigFilePath(project, 'schema.json');
    await rejectSymlinkIfExists(schemaPath, PROJECT_SCHEMA_FILE);
    const tempPath = path.join(configPath, `.schema.${process.pid}.${Date.now()}.json`);
    const body = `${JSON.stringify(schema, null, 2)}\n`;
    await fs.writeFile(tempPath, body, { flag: 'wx' });
    let backupSchemaPath: string | undefined;
    try {
      if (await fileExists(schemaPath)) {
        const currentSchema = await readJsonFile(schemaPath, `Project schema not found: ${id}`);
        if (expectedSchema !== undefined && !jsonEqual(currentSchema, expectedSchema)) {
          throw new Error('Project schema changed while saving. Refresh the project and try again.');
        }
        backupSchemaPath = await nextSchemaBackupName(project);
        await fs.copyFile(schemaPath, path.join(project, backupSchemaPath), fsConstants.COPYFILE_EXCL);
        await fs.unlink(schemaPath);
      }
      await fs.rename(tempPath, schemaPath);
      return { projectId: id, schemaPath: PROJECT_SCHEMA_FILE, backupSchemaPath, schema };
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  async getProjectUser(projectId: string): Promise<ProjectUser> {
    const project = this.projectPath(assertProjectId(projectId));
    return getProjectUser(this.loadProjectConfig(project, { log: false }));
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const id = assertRecordId(recordId);
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const schema = await this.readProjectSchema(project);
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
    return { username: user.username, record: buildRecordDetail(projectId, id, schema, data, await this.readFeedbackConfig(project, schema)) };
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertRecordId(recordId);
    const existing = await this.readRecordData(projectId, id);
    const feedback = isPlainRecord(existing) ? reservedRecordProperties(existing) : {};
    const next = isPlainRecord(data) ? { ...data, ...feedback } : data;
    return this.writeRecordData(projectId, id, next);
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const promptPath = await this.projectConfigFilePath(this.projectPath(assertProjectId(projectId)), 'prompt.md');
    await rejectSymlinkIfExists(promptPath, PROJECT_PROMPT_FILE);
    return readOptionalTextFile(promptPath);
  }

  async getProjectConfig(projectId: string): Promise<Record<string, string>> {
    return this.loadProjectConfig(this.projectPath(assertProjectId(projectId)));
  }

  async getProjectMcpConfig(projectId: string): Promise<string | undefined> {
    const mcpPath = await this.projectConfigFilePath(this.projectPath(assertProjectId(projectId)), 'mcp.json');
    await rejectSymlinkIfExists(mcpPath, PROJECT_MCP_FILE);
    return readOptionalTextFile(mcpPath);
  }

  async getTagDefinitions(projectId: string): Promise<import('../shared/types').TagDefinition[]> {
    const project = this.projectPath(assertProjectId(projectId));
    return loadManualTagDefinitionsFromDirectories([await this.projectConfigDirectoryPath(project), this.appConfigPath()]);
  }

  async listProjectTags(projectId: string): Promise<string[]> {
    const id = assertProjectId(projectId);
    const project = await this.openProject(id);
    const tagsPath = project.feedbackConfig ? tagsMappingPath(project.feedbackConfig) : undefined;
    return collectProjectTagNames(project.tagDefinitions ?? [], project.records, (recordId) => this.readRecordData(id, recordId), tagsPath);
  }

  async reconcileRecordTags(projectId: string, data: unknown): Promise<ReconcileTagsResult> {
    const project = this.projectPath(assertProjectId(projectId));
    const schema = await this.readProjectSchema(project);
    const feedbackConfig = await this.readFeedbackConfig(project, schema);
    const tagDefinitions = await this.getTagDefinitions(projectId);
    const plugins = await discoverComputedTagPlugins([this.appConfigPath()]);
    return reconcileComputedTags(schema, feedbackConfig, data, tagDefinitions, plugins);
  }

  private projectPath(projectId: string): string {
    return containedPath(this.root, projectId);
  }

  private loadProjectConfig(project: string, options?: { log?: boolean }): Record<string, string> {
    rejectConfigDirectorySymlinkIfExists(project);
    return loadProjectEnv(path.join(project, PROJECT_ENV_FILE), { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath) }, options);
  }

  private appConfigPath(): string {
    return path.dirname(this.config.appEnvPath);
  }

  private async readFeedbackConfig(project: string, schema: unknown): Promise<FeedbackConfig> {
    const configPath = await this.projectConfigFilePath(project, 'config.json');
    await rejectSymlinkIfExists(configPath, PROJECT_CONFIG_FILE);
    const config = await readOptionalJsonFile(configPath);
    return normalizeFeedbackConfig(schema, config);
  }

  private async readProjectSchema(project: string): Promise<unknown> {
    const schemaPath = await this.projectConfigFilePath(project, 'schema.json');
    await rejectSymlinkIfExists(schemaPath, PROJECT_SCHEMA_FILE);
    return readJsonFile(schemaPath, `Project is missing required ${PROJECT_SCHEMA_FILE}.`);
  }

  private async projectConfigFilePath(project: string, fileName: 'config.json' | 'mcp.json' | 'prompt.md' | 'schema.json' | 'tags.json'): Promise<string> {
    await this.projectConfigDirectoryPath(project);
    return containedPath(project, `${CONFIG_DIRECTORY}/${fileName}`);
  }

  private async projectConfigDirectoryPath(project: string): Promise<string> {
    const configPath = containedPath(project, CONFIG_DIRECTORY);
    try {
      const stat = await fs.lstat(configPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Project config directory cannot be a symlink.');
      }
      if (!stat.isDirectory()) {
        throw new Error('Project config path must be a directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return configPath;
      }
      throw error;
    }
    return configPath;
  }
}

export class AzureBlobStorageAdapter implements StorageAdapter {
  private readonly client: BlobServiceClient;
  private readonly queueServiceClient: QueueServiceClient;
  private readonly containerName: string;
  private readonly recordBaselines = new Map<string, { data: unknown; etag: string }>();
  private readonly schemaBaselines = new Map<string, { content: string; schema: unknown; etag: string }>();
  private readonly recordLeases = new Map<string, AzureRecordLease>();

  constructor(private readonly config: AppConfig, client?: BlobServiceClient, queueServiceClient?: QueueServiceClient) {
    const containerName = config.values.AZURE_STORAGE_CONTAINER;
    if (!containerName) {
      throw new Error('AZURE_STORAGE_CONTAINER is required for Azure Blob storage.');
    }
    this.containerName = containerName;
    if (client) {
      this.client = client;
      this.queueServiceClient = queueServiceClient ?? createQueueServiceClient(config);
      return;
    }
    if (config.backendKind === 'azure-connection-string') {
      this.client = BlobServiceClient.fromConnectionString(config.values.AZURE_STORAGE_ACCOUNT_CONNSTRING);
      this.queueServiceClient = QueueServiceClient.fromConnectionString(config.values.AZURE_STORAGE_ACCOUNT_CONNSTRING);
      return;
    }
    const accountName = config.values.AZURE_STORAGE_ACCOUNT_NAME;
    if (!accountName) {
      throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required for DefaultAzureCredential.');
    }
    this.client = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new DefaultAzureCredential());
    this.queueServiceClient = new QueueServiceClient(`https://${accountName}.queue.core.windows.net`, new DefaultAzureCredential());
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.withAzureErrorContext('list projects', async () => {
      const projects = new Set<string>();
      for await (const blob of this.container().listBlobsFlat()) {
        const projectId = projectIdFromRootBlob(blob.name);
        if (projectId) {
          projects.add(projectId);
        }
      }
      return [...projects].sort((a, b) => a.localeCompare(b)).map((id) => ({ id, name: id }));
    });
  }

  async createProject(projectId: string): Promise<ProjectSummary> {
    const id = assertNewProjectId(projectId);
    const container = this.container();
    await container.createIfNotExists();
    const schemaBlob = container.getBlockBlobClient(projectBlobName(id, PROJECT_SCHEMA_FILE));
    const schema = JSON.stringify(NEW_PROJECT_SCHEMA, null, 2);
    try {
      await schemaBlob.upload(schema, Buffer.byteLength(schema), { conditions: { ifNoneMatch: '*' } });
    } catch (error) {
      if (isBlobConditionConflict(error)) {
        throw new Error(`Project already exists: ${id}`);
      }
      throw error;
    }
    const feedbackConfig = JSON.stringify(toPersistedFeedbackConfig(normalizeFeedbackConfig(NEW_PROJECT_SCHEMA, undefined)), null, 2);
    await container.getBlockBlobClient(projectBlobName(id, PROJECT_CONFIG_FILE)).upload(feedbackConfig, Buffer.byteLength(feedbackConfig));
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const schemaText = await this.readProjectSchemaBlob(container, id);
    const schema = JSON.parse(schemaText) as unknown;
    const projectEnv = await this.readOptionalBlob(container, projectBlobName(id, PROJECT_ENV_FILE));
    const projectConfig = redactConfig(this.mergeAzureProjectConfig(await this.getAppConfig(), projectEnv));
    const feedbackConfig = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE)));
    const tagDefinitions = await this.getTagDefinitions(id);
    const records: RecordSummary[] = [];
    for await (const blob of container.listBlobsFlat({ prefix: `${id}/` })) {
      const relativeName = blob.name.slice(`${id}/`.length);
      if (isRecordFile(relativeName)) {
        const recordId = relativeName.slice(0, -'.json'.length);
        records.push({ id: recordId, displayName: recordId });
      }
    }
    return { project: { id, name: id }, schema, records: records.sort((a, b) => a.displayName.localeCompare(b.displayName)), projectConfig, feedbackConfig, tagDefinitions };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    return this.renderRecordData(projectId, recordId, await this.readRecordData(projectId, recordId));
  }

  async obtainExclusiveLease(projectId: string, recordId: string): Promise<ExclusiveLeaseResult> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const key = recordBaselineKey(id, record);
    if (this.recordLeases.has(key)) {
      return { status: 'SUCCESS' };
    }
    const blob = this.container().getBlobClient(projectBlobName(id, `${record}.json`));
    if (!(await blob.exists())) {
      throw new Error(`Record not found: ${record}`);
    }
    const proposedLeaseId = randomUUID();
    const leaseClient = blob.getBlobLeaseClient(proposedLeaseId);
    try {
      await leaseClient.acquireLease(AZURE_BLOB_LEASE_SECONDS);
    } catch (error) {
      if (isBlobLeaseConflict(error)) {
        return { status: 'FAILURE' };
      }
      throw error;
    }
    const entry: AzureRecordLease = {
      leaseClient,
      leaseId: proposedLeaseId,
      renewTimer: setInterval(() => {
        void this.renewRecordLease(key, id, record);
      }, AZURE_BLOB_LEASE_RENEW_MS)
    };
    entry.renewTimer.unref?.();
    this.recordLeases.set(key, entry);
    return { status: 'SUCCESS' };
  }

  async releaseExclusiveLease(projectId: string, recordId: string): Promise<void> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const key = recordBaselineKey(id, record);
    const entry = this.recordLeases.get(key);
    if (!entry) {
      return;
    }
    clearInterval(entry.renewTimer);
    this.recordLeases.delete(key);
    try {
      await entry.leaseClient.releaseLease();
    } catch (error) {
      if (!isBlobLeaseAlreadyReleased(error)) {
        throw error;
      }
    }
  }

  async readRecordData(projectId: string, recordId: string): Promise<unknown> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.container();
    const response = await this.readBlobWithProperties(container, projectBlobName(id, `${record}.json`), `Record not found: ${record}`);
    const data = JSON.parse(response.content) as unknown;
    this.rememberRecordBaseline(id, record, data, response.etag);
    return data;
  }

  async renderRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.container();
    const schema = JSON.parse(await this.readProjectSchemaBlob(container, id)) as unknown;
    return buildRecordDetail(id, record, schema, data, normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE))));
  }

  async writeRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const body = `${JSON.stringify(data, null, 2)}\n`;
    const response = await this.container().getBlockBlobClient(projectBlobName(id, `${record}.json`)).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions: this.recordLeaseCondition(id, record)
    });
    this.rememberRecordBaseline(id, record, data, response.etag);
    return this.renderRecordData(id, record, data);
  }

  async writeRecordDataIfUnchanged(projectId: string, recordId: string, data: unknown, expectedData: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.container();
    const blob = container.getBlockBlobClient(projectBlobName(id, `${record}.json`));
    if (expectedData === undefined) {
      const body = `${JSON.stringify(data, null, 2)}\n`;
      try {
        const response = await blob.upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*', ...this.recordLeaseCondition(id, record) }
        });
        this.rememberRecordBaseline(id, record, data, response.etag);
      } catch (error) {
        if (isBlobConditionConflict(error)) {
          throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
        }
        throw error;
      }
      return this.renderRecordData(id, record, data);
    }
    const baseline = this.recordBaselines.get(recordBaselineKey(id, record));
    const conditionEtag = baseline && jsonEqual(baseline.data, expectedData) ? baseline.etag : undefined;
    const current = conditionEtag ? undefined : await blob.download();
    if (!conditionEtag) {
      const currentData = JSON.parse(await streamToString(current?.readableStreamBody)) as unknown;
      if (!jsonEqual(currentData, expectedData) || !current?.etag) {
        throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
      }
    }
    const etag = conditionEtag ?? current?.etag;
    if (!etag) {
      throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
    }
    const body = `${JSON.stringify(data, null, 2)}\n`;
    try {
      const response = await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifMatch: etag, ...this.recordLeaseCondition(id, record) }
      });
      this.rememberRecordBaseline(id, record, data, response.etag);
    } catch (error) {
      if (isBlobConditionConflict(error)) {
        throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
      }
      throw error;
    }
    return this.renderRecordData(id, record, data);
  }

  async getFeedbackConfig(projectId: string): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const schema = JSON.parse(await this.readProjectSchemaBlob(container, id)) as unknown;
    return normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE)));
  }

  async saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const schema = JSON.parse(await this.readProjectSchemaBlob(container, id)) as unknown;
    const normalized = normalizeFeedbackConfig(schema, config);
    const body = `${JSON.stringify(toPersistedFeedbackConfig(normalized), null, 2)}\n`;
    await container.getBlockBlobClient(projectBlobName(id, PROJECT_CONFIG_FILE)).upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return normalized;
  }

  async saveProjectSchema(projectId: string, schema: unknown, expectedSchema?: unknown): Promise<ProjectSchemaSaveResult> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const schemaBlob = container.getBlockBlobClient(projectBlobName(id, PROJECT_SCHEMA_FILE));
    const body = `${JSON.stringify(schema, null, 2)}\n`;
    let backupSchemaPath: string | undefined;
    if (await schemaBlob.exists()) {
      const baseline = expectedSchema === undefined ? undefined : this.schemaBaselines.get(id);
      const existing =
        baseline && jsonEqual(baseline.schema, expectedSchema)
          ? { content: baseline.content, schema: baseline.schema, etag: baseline.etag }
          : await this.readExistingSchemaForSave(schemaBlob, id, expectedSchema);
      if (expectedSchema !== undefined && !jsonEqual(existing.schema, expectedSchema)) {
        throw new Error('Project schema changed while saving. Refresh the project and try again.');
      }
      try {
        const response = await schemaBlob.upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifMatch: existing.etag }
        });
        this.rememberSchemaBaseline(id, body, schema, response.etag, { replace: true });
        backupSchemaPath = await this.uploadSchemaBackup(container, id, existing.content);
      } catch (error) {
        if (isBlobConditionConflict(error)) {
          throw new Error('Project schema changed while saving. Refresh the project and try again.');
        }
        throw error;
      }
    } else {
      try {
        const response = await schemaBlob.upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' }
        });
        this.rememberSchemaBaseline(id, body, schema, response.etag, { replace: true });
      } catch (error) {
        if (isBlobConditionConflict(error)) {
          throw new Error('Project schema changed while saving. Refresh the project and try again.');
        }
        throw error;
      }
    }
    return { projectId: id, schemaPath: PROJECT_SCHEMA_FILE, backupSchemaPath, schema };
  }

  async getProjectUser(projectId: string): Promise<ProjectUser> {
    const id = assertProjectId(projectId);
    const projectEnv = await this.readOptionalBlob(this.container(), projectBlobName(id, PROJECT_ENV_FILE));
    return getProjectUser(this.mergeAzureProjectConfig(await this.getAppConfig(), projectEnv));
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const container = this.container();
    const schema = JSON.parse(await this.readProjectSchemaBlob(container, id)) as unknown;
    const config = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE)));
    assertSubmissionAllowed(config, validInput);
    const user = getProjectUser(this.mergeAzureProjectConfig(await this.getAppConfig(), await this.readOptionalBlob(container, projectBlobName(id, PROJECT_ENV_FILE))));
    if (!user.valid || !user.username) {
      throw new Error(user.validationMessage);
    }
    const blob = container.getBlockBlobClient(projectBlobName(id, `${record}.json`));
    const data = JSON.parse(await this.readBlob(container, projectBlobName(id, `${record}.json`), `Record not found: ${record}`)) as unknown;
    if (!isPlainRecord(data)) {
      throw new Error('Feedback can only be added to object records.');
    }
    mergeFeedbackEntries(data, validInput, user.username);
    const body = `${JSON.stringify(data, null, 2)}\n`;
    await blob.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions: this.recordLeaseCondition(id, record)
    });
    return {
      username: user.username,
      record: buildRecordDetail(id, record, schema, data, normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE))))
    };
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const existing = await this.readRecordData(id, record);
    const feedback = isPlainRecord(existing) ? reservedRecordProperties(existing) : {};
    const next = isPlainRecord(data) ? { ...data, ...feedback } : data;
    return this.writeRecordData(id, record, next);
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const id = assertProjectId(projectId);
    return this.readOptionalBlob(this.container(), projectBlobName(id, PROJECT_PROMPT_FILE));
  }

  async getProjectConfig(projectId: string): Promise<Record<string, string>> {
    const id = assertProjectId(projectId);
    const projectEnv = await this.readOptionalBlob(this.container(), projectBlobName(id, PROJECT_ENV_FILE));
    return this.mergeAzureProjectConfig(await this.getAppConfig(), projectEnv);
  }

  async getProjectMcpConfig(projectId: string): Promise<string | undefined> {
    const id = assertProjectId(projectId);
    return this.readOptionalBlob(this.container(), projectBlobName(id, PROJECT_MCP_FILE));
  }

  async getTagDefinitions(projectId: string): Promise<import('../shared/types').TagDefinition[]> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const projectDefinitions = await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_TAGS_FILE));
    const appDefinitions = await this.readOptionalJsonBlob(container, PROJECT_TAGS_FILE);
    return loadManualTagDefinitionsFromValues([projectDefinitions, appDefinitions]);
  }

  async listProjectTags(projectId: string): Promise<string[]> {
    const id = assertProjectId(projectId);
    const project = await this.openProject(id);
    const tagsPath = project.feedbackConfig ? tagsMappingPath(project.feedbackConfig) : undefined;
    return collectProjectTagNames(project.tagDefinitions ?? [], project.records, (recordId) => this.readRecordData(id, recordId), tagsPath);
  }

  async reconcileRecordTags(projectId: string, data: unknown): Promise<ReconcileTagsResult> {
    const id = assertProjectId(projectId);
    const container = this.container();
    const schema = JSON.parse(await this.readProjectSchemaBlob(container, id)) as unknown;
    const feedbackConfig = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, projectBlobName(id, PROJECT_CONFIG_FILE)));
    const tagDefinitions = await this.getTagDefinitions(id);
    const plugins = await discoverComputedTagPlugins([path.dirname(this.config.appEnvPath)]);
    return reconcileComputedTags(schema, feedbackConfig, data, tagDefinitions, plugins);
  }

  async listQueues(): Promise<QueueInfo[]> {
    return this.withAzureQueueErrorContext('list queues', async () => {
      const queues: QueueInfo[] = [];
      for await (const queue of this.queueServiceClient.listQueues()) {
        queues.push(await this.queueInfo(queue.name));
      }
      return queues.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async createQueue(queueName: string): Promise<QueueInfo> {
    const name = assertQueueName(queueName);
    return this.withAzureQueueErrorContext('create queue', async () => {
      try {
        await this.queue(name).create();
      } catch (error) {
        if (isQueueAlreadyExists(error)) {
          throw new Error(`Queue '${name}' already exists`);
        }
        throw error;
      }
      return this.queueInfo(name);
    });
  }

  async deleteQueue(queueName: string): Promise<void> {
    const name = assertQueueName(queueName);
    await this.withAzureQueueErrorContext('delete queue', async () => {
      await this.queue(name).delete();
    });
  }

  async clearQueue(queueName: string): Promise<void> {
    const name = assertQueueName(queueName);
    await this.withAzureQueueErrorContext('clear queue', async () => {
      await this.queue(name).clearMessages();
    });
  }

  async enqueueMessage(queueName: string, message: QueueMessage): Promise<void> {
    const name = assertQueueName(queueName);
    const body = JSON.stringify({
      project: assertProjectId(message.project),
      filename: assertRecordId(message.filename),
      ...(message.instructions === undefined ? {} : { instructions: message.instructions })
    });
    await this.withAzureQueueErrorContext('enqueue message', async () => {
      await this.queue(name).sendMessage(body);
    });
  }

  async dequeueMessage(queueName: string): Promise<DequeueResult | null> {
    const name = assertQueueName(queueName);
    return this.withAzureQueueErrorContext('dequeue message', async () => {
      const response = await this.queue(name).receiveMessages({ numberOfMessages: 1 });
      const item = response.receivedMessageItems[0];
      if (!item) {
        return null;
      }
      const message = JSON.parse(item.messageText) as QueueMessage;
      return {
        message: {
          project: assertProjectId(message.project),
          filename: assertRecordId(message.filename),
          ...(typeof message.instructions === 'string' ? { instructions: message.instructions } : {})
        },
        popReceipt: encodeQueueReceipt({ messageId: item.messageId, popReceipt: item.popReceipt })
      };
    });
  }

  async completeMessage(queueName: string, popReceipt: string): Promise<void> {
    const name = assertQueueName(queueName);
    const receipt = decodeQueueReceipt(popReceipt);
    await this.withAzureQueueErrorContext('complete message', async () => {
      await this.queue(name).deleteMessage(receipt.messageId, receipt.popReceipt);
    });
  }

  async searchRecords(projectId: string, tagFilter: TagFilter): Promise<RecordSummary[]> {
    const id = assertProjectId(projectId);
    const included = new Set(tagFilter.included);
    const excluded = new Set(tagFilter.excluded);
    const project = await this.openProject(id);
    const tagsPath = project.feedbackConfig ? tagsMappingPath(project.feedbackConfig) : undefined;
    const matches: RecordSummary[] = [];
    for (const record of project.records) {
      const data = await this.readRecordData(id, record.id);
      const tags = recordTags(data, tagsPath);
      const hasIncluded = included.size === 0 || [...included].some((tag) => tags.has(tag));
      const hasExcluded = [...excluded].some((tag) => tags.has(tag));
      if (hasIncluded && !hasExcluded) {
        matches.push(record);
      }
    }
    return matches;
  }

  async getAppPrompt(): Promise<string | undefined> {
    return this.readOptionalBlob(this.container(), PROJECT_PROMPT_FILE);
  }

  async getAppConfig(): Promise<Record<string, string>> {
    return this.withAzureErrorContext('load app config', async () => this.mergeAzureAppConfig(await this.readOptionalBlob(this.container(), PROJECT_ENV_FILE)));
  }

  async getAppMcpConfig(): Promise<string | undefined> {
    return this.readOptionalBlob(this.container(), PROJECT_MCP_FILE);
  }

  private async readProjectSchemaBlob(container: ReturnType<BlobServiceClient['getContainerClient']>, projectId: string): Promise<string> {
    const response = await this.readBlobWithProperties(container, projectBlobName(projectId, PROJECT_SCHEMA_FILE), `Project is missing required ${PROJECT_SCHEMA_FILE}.`);
    this.rememberSchemaBaseline(projectId, response.content, JSON.parse(response.content) as unknown, response.etag, { replace: false });
    return response.content;
  }

  private async readBlob(container: ReturnType<BlobServiceClient['getContainerClient']>, name: string, missingMessage: string): Promise<string> {
    const blob = container.getBlobClient(name);
    if (!(await blob.exists())) {
      throw new Error(missingMessage);
    }
    const response = await blob.download();
    return streamToString(response.readableStreamBody);
  }

  private async readBlobWithProperties(
    container: ReturnType<BlobServiceClient['getContainerClient']>,
    name: string,
    missingMessage: string
  ): Promise<{ content: string; etag?: string }> {
    const blob = container.getBlobClient(name);
    if (!(await blob.exists())) {
      throw new Error(missingMessage);
    }
    const response = await blob.download();
    return { content: await streamToString(response.readableStreamBody), etag: response.etag };
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

  private async uploadSchemaBackup(container: ReturnType<BlobServiceClient['getContainerClient']>, projectId: string, content: string): Promise<string> {
    for (let index = 1; ; index += 1) {
      const name = `${CONFIG_DIRECTORY}/schema_${index}.json`;
      try {
        await container.getBlockBlobClient(projectBlobName(projectId, name)).upload(content, Buffer.byteLength(content), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' }
        });
        return name;
      } catch (error) {
        if (isBlobConditionConflict(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private container(): ReturnType<BlobServiceClient['getContainerClient']> {
    return this.client.getContainerClient(this.containerName);
  }

  private queue(queueName: string): QueueClient {
    return this.queueServiceClient.getQueueClient(queueName);
  }

  private async queueInfo(queueName: string): Promise<QueueInfo> {
    const properties = await this.queue(queueName).getProperties();
    return { name: queueName, messageCount: properties.approximateMessagesCount ?? 0 };
  }

  private async withAzureErrorContext<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw describeAzureStorageError(error, {
        operation,
        containerName: this.containerName,
        accountName: this.config.values.AZURE_STORAGE_ACCOUNT_NAME
      });
    }
  }

  private async withAzureQueueErrorContext<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw describeAzureQueueError(error, {
        operation,
        accountName: this.config.values.AZURE_STORAGE_ACCOUNT_NAME
      });
    }
  }

  private mergeAzureAppConfig(appEnv: string | undefined): Record<string, string> {
    return appEnv ? { ...this.config.values, ...parseAzureConfigEnv(appEnv, 'app config/.env') } : { ...this.config.values };
  }

  private mergeAzureProjectConfig(appConfig: Record<string, string>, projectEnv: string | undefined): Record<string, string> {
    return projectEnv ? { ...appConfig, ...parseAzureConfigEnv(projectEnv, 'project config/.env') } : { ...appConfig };
  }

  private async readExistingSchemaForSave(
    schemaBlob: ReturnType<ReturnType<BlobServiceClient['getContainerClient']>['getBlockBlobClient']>,
    projectId: string,
    expectedSchema: unknown | undefined
  ): Promise<{ content: string; schema: unknown; etag: string }> {
    const response = await schemaBlob.download();
    const content = await streamToString(response.readableStreamBody);
    const schema = JSON.parse(content) as unknown;
    if (expectedSchema !== undefined && !jsonEqual(schema, expectedSchema)) {
      throw new Error('Project schema changed while saving. Refresh the project and try again.');
    }
    if (!response.etag) {
      throw new Error('Project schema changed while saving. Refresh the project and try again.');
    }
    this.rememberSchemaBaseline(projectId, content, schema, response.etag, { replace: true });
    return { content, schema, etag: response.etag };
  }

  private rememberRecordBaseline(projectId: string, recordId: string, data: unknown, etag: string | undefined): void {
    const key = recordBaselineKey(projectId, recordId);
    if (etag) {
      this.recordBaselines.set(key, { data: cloneJson(data), etag });
      return;
    }
    this.recordBaselines.delete(key);
  }

  private rememberSchemaBaseline(projectId: string, content: string, schema: unknown, etag: string | undefined, options: { replace: boolean }): void {
    if (etag) {
      const existing = this.schemaBaselines.get(projectId);
      if (!options.replace && existing && jsonEqual(existing.schema, schema)) {
        return;
      }
      this.schemaBaselines.set(projectId, { content, schema: cloneJson(schema), etag });
      return;
    }
    this.schemaBaselines.delete(projectId);
  }

  private recordLeaseCondition(projectId: string, recordId: string): { leaseId?: string } {
    return { leaseId: this.recordLeases.get(recordBaselineKey(projectId, recordId))?.leaseId };
  }

  private async renewRecordLease(key: string, projectId: string, recordId: string): Promise<void> {
    const entry = this.recordLeases.get(key);
    if (!entry) {
      return;
    }
    try {
      await entry.leaseClient.renewLease();
    } catch (error) {
      if (this.recordLeases.get(key) === entry) {
        clearInterval(entry.renewTimer);
        this.recordLeases.delete(key);
      }
      logError('review-assistant.storage-lease-renewal-failed', {
        projectId,
        recordId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

type AzureRecordLease = {
  leaseClient: BlobLeaseClient;
  leaseId: string;
  renewTimer: NodeJS.Timeout;
};

const AZURE_BLOB_LEASE_SECONDS = 60;
const AZURE_BLOB_LEASE_RENEW_MS = 45_000;
const QUEUES_UNSUPPORTED_MESSAGE = 'Queues are only available with Azure Blob Storage backend';

const isRecordFile = (name: string): boolean => name.endsWith('.json') && !path.basename(name).startsWith('_') && !name.includes('/');

const projectBlobName = (projectId: string, name: string): string => `${projectId}/${name}`;

const recordBaselineKey = (projectId: string, recordId: string): string => `${projectId}\u0000${recordId}`;

const createQueueServiceClient = (config: AppConfig): QueueServiceClient => {
  if (config.backendKind === 'azure-connection-string') {
    return QueueServiceClient.fromConnectionString(config.values.AZURE_STORAGE_ACCOUNT_CONNSTRING);
  }
  const accountName = config.values.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required for DefaultAzureCredential.');
  }
  return new QueueServiceClient(`https://${accountName}.queue.core.windows.net`, new DefaultAzureCredential());
};

const encodeQueueReceipt = (receipt: { messageId: string; popReceipt: string }): string =>
  Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');

const decodeQueueReceipt = (value: string): { messageId: string; popReceipt: string } => {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  if (!isPlainRecord(parsed) || typeof parsed.messageId !== 'string' || typeof parsed.popReceipt !== 'string') {
    throw new Error('Invalid queue pop receipt.');
  }
  return { messageId: parsed.messageId, popReceipt: parsed.popReceipt };
};

const reservedRecordProperties = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('_feedback') || key === '_history'));

const stripReservedRecordProperties = (data: unknown): unknown => {
  const stripped = stripFeedbackProperties(data);
  if (!isPlainRecord(stripped)) {
    return stripped;
  }
  const { _history: _history, ...rest } = stripped;
  return rest;
};

const collectProjectTagNames = async (
  definitions: import('../shared/types').TagDefinition[],
  records: RecordSummary[],
  readRecordData: (recordId: string) => Promise<unknown>,
  tagsPath: string | undefined
): Promise<string[]> => {
  const tags = new Set(definitions.map((definition) => definition.name));
  for (const record of records) {
    for (const tag of recordTags(await readRecordData(record.id), tagsPath)) {
      tags.add(tag);
    }
  }
  return [...tags].sort((left, right) => left.localeCompare(right));
};

const recordTags = (data: unknown, tagsPath: string | undefined): Set<string> => {
  const value = tagsPath ? readJsonPointer(data, tagsPath) : isPlainRecord(data) ? data.tags : undefined;
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean));
};

const readJsonPointer = (data: unknown, pointer: string): unknown => {
  if (pointer === '') {
    return data;
  }
  if (!pointer.startsWith('/')) {
    throw new Error('Invalid JSON pointer.');
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) {
        const index = Number(segment);
        return Number.isInteger(index) && index >= 0 ? current[index] : undefined;
      }
      return isPlainRecord(current) ? current[segment] : undefined;
    }, data);
};

const projectIdFromRootBlob = (name: string): string | undefined => {
  const separatorIndex = name.indexOf('/');
  if (separatorIndex <= 0) {
    return undefined;
  }
  const projectId = name.slice(0, separatorIndex);
  return projectId === CONFIG_DIRECTORY || projectId.startsWith('.') ? undefined : projectId;
};

const rejectSymlinkIfExists = async (filePath: string, label: string): Promise<void> => {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`Project config file cannot be a symlink: ${label}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

const rejectConfigDirectorySymlinkIfExists = (project: string): void => {
  const configPath = containedPath(project, CONFIG_DIRECTORY);
  try {
    const stat = lstatSync(configPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Project config directory cannot be a symlink.');
    }
    if (!stat.isDirectory()) {
      throw new Error('Project config path must be a directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

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
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const nextSchemaBackupName = async (projectPath: string): Promise<string> => {
  for (let index = 1; ; index += 1) {
    const name = `${CONFIG_DIRECTORY}/schema_${index}.json`;
    if (!(await fileExists(path.join(projectPath, name)))) {
      return name;
    }
  }
};

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const isBlobConditionConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const details = error as { statusCode?: number; code?: string };
  return details.statusCode === 412 || details.code === 'BlobAlreadyExists' || details.code === 'ConditionNotMet';
};

const isBlobLeaseConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const details = error as { statusCode?: number; code?: string };
  return details.statusCode === 409 || details.code === 'LeaseAlreadyPresent';
};

const isBlobLeaseAlreadyReleased = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const details = error as { statusCode?: number; code?: string };
  return details.statusCode === 409 || details.code === 'LeaseNotPresentWithLeaseOperation';
};

const isQueueAlreadyExists = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const details = error as { statusCode?: number; code?: string };
  return details.statusCode === 409 || details.code === 'QueueAlreadyExists';
};

const describeAzureStorageError = (
  error: unknown,
  context: {
    operation: string;
    containerName: string;
    accountName?: string;
  }
): Error => {
  if (!isAzureStorageServiceError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const statusText = error.statusCode ? `HTTP ${error.statusCode}` : 'Azure Storage request';
  const codeText = error.code ? ` (${error.code})` : '';
  const messageText = error.message.trim() ? ` ${error.message.trim()}` : '';
  const targetText = context.accountName ? ` account "${context.accountName}", container "${context.containerName}"` : ` container "${context.containerName}"`;
  const remediation =
    error.statusCode === 403 || error.code === 'AuthorizationFailure' || error.code === 'AuthenticationFailed' || error.code === 'AuthorizationPermissionMismatch'
      ? ' The storage account may be blocking this machine with firewall or virtual network rules, or the signed-in identity may be missing Blob Data permissions.'
      : '';
  return new Error(`Azure Blob Storage failed to ${context.operation} for${targetText}: ${statusText}${codeText}.${messageText}${remediation}`);
};

const describeAzureQueueError = (
  error: unknown,
  context: {
    operation: string;
    accountName?: string;
  }
): Error => {
  if (!isAzureStorageServiceError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const statusText = error.statusCode ? `HTTP ${error.statusCode}` : 'Azure Queue request';
  const codeText = error.code ? ` (${error.code})` : '';
  const messageText = error.message.trim() ? ` ${error.message.trim()}` : '';
  const targetText = context.accountName ? ` account "${context.accountName}"` : ' configured account';
  const remediation =
    error.statusCode === 403 || error.code === 'AuthorizationFailure' || error.code === 'AuthenticationFailed' || error.code === 'AuthorizationPermissionMismatch'
      ? ' The storage account may be blocking this machine with firewall or virtual network rules, or the signed-in identity may be missing Queue Data permissions.'
      : '';
  return new Error(`Azure Queue Storage failed to ${context.operation} for${targetText}: ${statusText}${codeText}.${messageText}${remediation}`);
};

const isAzureStorageServiceError = (error: unknown): error is { statusCode?: number; code?: string; message: string } => {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return false;
  }
  const details = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  return typeof details.message === 'string' && (typeof details.statusCode === 'number' || typeof details.code === 'string');
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

const parseAzureConfigEnv = (content: string, label: string): Record<string, string> => {
  const values = Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        if (index <= 0) {
          throw new Error(`Invalid ${label} line: ${line}`);
        }
        const key = line.slice(0, index).trim();
        if (!/^[A-Z0-9_]+$/.test(key)) {
          throw new Error(`Invalid ${label} variable name: ${key}`);
        }
        return [key, stripQuotes(line.slice(index + 1).trim())];
      })
  );
  const backendOverrides = Object.keys(values).filter((key) => BACKEND_KEYS.has(key));
  if (backendOverrides.length > 0) {
    throw new Error(`${label} cannot override backend selection keys: ${backendOverrides.join(', ')}`);
  }
  return values;
};

const stripQuotes = (value: string): string => {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export const buildRecordDetail = (projectId: string, recordId: string, schema: unknown, data: unknown, displayConfig?: FeedbackConfig): RecordDetail => {
  const coreData = stripReservedRecordProperties(data);
  const validationIssues = validateRecord(schema, coreData).filter((issue) => issue.keyword !== 'required');
  return {
    projectId,
    recordId,
    displayName: recordId,
    data: coreData,
    schema,
    validationIssues,
    renderTree: buildRenderTree(schema, coreData, validationIssues, 'record', displayConfig),
    feedbackHistory: extractFeedbackHistory(data, deriveFeedbackTargets(schema))
  };
};

export const assertSubmissionAllowed = (config: FeedbackConfig, input: FeedbackSubmissionInput): void => {
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
  if (input.editValue?.trim() && entry.editMode !== 'logged') {
    throw new Error('Edits are not enabled for this property.');
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
