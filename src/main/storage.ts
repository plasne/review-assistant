import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants, lstatSync } from 'node:fs';
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
  stripFeedbackProperties,
  toPersistedFeedbackConfig
} from '../shared/feedback';
import { assertNewProjectId, assertProjectId, assertRecordId } from '../shared/validators';
import { buildRenderTree, validateRecord } from './schema';
import { loadProjectEnv, readEnvFile, redactConfig } from './env';
import {
  discoverComputedTagPlugins,
  loadManualTagDefinitionsFromDirectories,
  loadManualTagDefinitionsFromValues,
  reconcileComputedTags,
  type ReconcileTagsResult
} from './tags';

export interface StorageAdapter {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(projectId: string): Promise<ProjectSummary>;
  openProject(projectId: string): Promise<OpenProjectResult>;
  getRecord(projectId: string, recordId: string): Promise<RecordDetail>;
  readRecordData?(projectId: string, recordId: string): Promise<unknown>;
  renderRecordData?(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  writeRecordData?(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  writeRecordDataIfUnchanged?(projectId: string, recordId: string, data: unknown, expectedData: unknown): Promise<RecordDetail>;
  getFeedbackConfig(projectId: string): Promise<FeedbackConfig>;
  saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig>;
  saveProjectSchema(projectId: string, schema: unknown): Promise<ProjectSchemaSaveResult>;
  getProjectUser(projectId: string): Promise<ProjectUser>;
  submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult>;
  updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail>;
  getProjectPrompt(projectId: string): Promise<string | undefined>;
  getProjectConfig(projectId: string): Promise<Record<string, string>>;
  getProjectMcpConfig(projectId: string): Promise<string | undefined>;
  getTagDefinitions(projectId: string): Promise<import('../shared/types').TagDefinition[]>;
  reconcileRecordTags(projectId: string, data: unknown): Promise<ReconcileTagsResult>;
}

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
const BACKEND_KEYS = new Set(['AZURE_STORAGE_ACCOUNT_CONNSTRING', 'AZURE_STORAGE_ACCOUNT_NAME', 'LOCAL_PATH']);
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

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    return this.renderRecordData(projectId, recordId, await this.readRecordData(projectId, recordId));
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

  async saveProjectSchema(projectId: string, schema: unknown): Promise<ProjectSchemaSaveResult> {
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
    const feedback = isPlainRecord(existing)
      ? Object.fromEntries(Object.entries(existing).filter(([key]) => key.endsWith('_feedback') || key.endsWith('_edits') || key.endsWith('_comments')))
      : {};
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
    await container.getBlockBlobClient(PROJECT_SCHEMA_FILE).upload(schema, Buffer.byteLength(schema));
    const feedbackConfig = JSON.stringify(toPersistedFeedbackConfig(normalizeFeedbackConfig(NEW_PROJECT_SCHEMA, undefined)), null, 2);
    await container.getBlockBlobClient(PROJECT_CONFIG_FILE).upload(feedbackConfig, Buffer.byteLength(feedbackConfig));
    return { id, name: id };
  }

  async openProject(projectId: string): Promise<OpenProjectResult> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schemaText = await this.readProjectSchemaBlob(container);
    const schema = JSON.parse(schemaText) as unknown;
    const projectEnv = await this.readOptionalBlob(container, PROJECT_ENV_FILE);
    const projectConfig = redactConfig(this.mergeAzureProjectConfig(projectEnv));
    const feedbackConfig = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE));
    const tagDefinitions = await this.getTagDefinitions(id);
    const records: RecordSummary[] = [];
    for await (const blob of container.listBlobsFlat()) {
      if (isRecordFile(blob.name)) {
        const recordId = blob.name.slice(0, -'.json'.length);
        records.push({ id: recordId, displayName: recordId });
      }
    }
    return { project: { id, name: id }, schema, records: records.sort((a, b) => a.displayName.localeCompare(b.displayName)), projectConfig, feedbackConfig, tagDefinitions };
  }

  async getRecord(projectId: string, recordId: string): Promise<RecordDetail> {
    return this.renderRecordData(projectId, recordId, await this.readRecordData(projectId, recordId));
  }

  async readRecordData(projectId: string, recordId: string): Promise<unknown> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    return JSON.parse(await this.readBlob(container, `${record}.json`, `Record not found: ${record}`)) as unknown;
  }

  async renderRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readProjectSchemaBlob(container)) as unknown;
    return buildRecordDetail(id, record, schema, data, normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE)));
  }

  async writeRecordData(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const body = `${JSON.stringify(data, null, 2)}\n`;
    await this.client
      .getContainerClient(id)
      .getBlockBlobClient(`${record}.json`)
      .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return this.renderRecordData(id, record, data);
  }

  async writeRecordDataIfUnchanged(projectId: string, recordId: string, data: unknown, expectedData: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const container = this.client.getContainerClient(id);
    const blob = container.getBlockBlobClient(`${record}.json`);
    if (expectedData === undefined) {
      const body = `${JSON.stringify(data, null, 2)}\n`;
      try {
        await blob.upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' }
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 412) {
          throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
        }
        throw error;
      }
      return this.renderRecordData(id, record, data);
    }
    const response = await blob.download();
    const current = JSON.parse(await streamToString(response.readableStreamBody)) as unknown;
    if (!jsonEqual(current, expectedData) || !response.etag) {
      throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
    }
    const body = `${JSON.stringify(data, null, 2)}\n`;
    try {
      await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifMatch: response.etag }
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 412) {
        throw new Error(RECORD_DRAFT_CONFLICT_MESSAGE);
      }
      throw error;
    }
    return this.renderRecordData(id, record, data);
  }

  async getFeedbackConfig(projectId: string): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readProjectSchemaBlob(container)) as unknown;
    return normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE));
  }

  async saveFeedbackConfig(projectId: string, config: FeedbackConfig): Promise<FeedbackConfig> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readProjectSchemaBlob(container)) as unknown;
    const normalized = normalizeFeedbackConfig(schema, config);
    const body = `${JSON.stringify(toPersistedFeedbackConfig(normalized), null, 2)}\n`;
    await container.getBlockBlobClient(PROJECT_CONFIG_FILE).upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return normalized;
  }

  async saveProjectSchema(projectId: string, schema: unknown): Promise<ProjectSchemaSaveResult> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schemaBlob = container.getBlockBlobClient(PROJECT_SCHEMA_FILE);
    const body = `${JSON.stringify(schema, null, 2)}\n`;
    let backupSchemaPath: string | undefined;
    if (await schemaBlob.exists()) {
      const existing = await this.readProjectSchemaBlob(container);
      backupSchemaPath = await this.nextSchemaBackupName(container);
      await container.getBlockBlobClient(backupSchemaPath).upload(existing, Buffer.byteLength(existing), {
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });
    }
    await schemaBlob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return { projectId: id, schemaPath: PROJECT_SCHEMA_FILE, backupSchemaPath, schema };
  }

  async getProjectUser(projectId: string): Promise<ProjectUser> {
    const id = assertProjectId(projectId);
    const projectEnv = await this.readOptionalBlob(this.client.getContainerClient(id), PROJECT_ENV_FILE);
    return getProjectUser(this.mergeAzureProjectConfig(projectEnv));
  }

  async submitFeedback(projectId: string, recordId: string, input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const validInput = assertNonEmptyFeedbackSubmission(input);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readProjectSchemaBlob(container)) as unknown;
    const config = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE));
    assertSubmissionAllowed(config, validInput);
    const user = getProjectUser(this.mergeAzureProjectConfig(await this.readOptionalBlob(container, PROJECT_ENV_FILE)));
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
    return {
      username: user.username,
      record: buildRecordDetail(id, record, schema, data, normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE)))
    };
  }

  async updateRecord(projectId: string, recordId: string, data: unknown): Promise<RecordDetail> {
    const id = assertProjectId(projectId);
    const record = assertRecordId(recordId);
    const existing = await this.readRecordData(id, record);
    const feedback = isPlainRecord(existing)
      ? Object.fromEntries(Object.entries(existing).filter(([key]) => key.endsWith('_feedback') || key.endsWith('_edits') || key.endsWith('_comments')))
      : {};
    const next = isPlainRecord(data) ? { ...data, ...feedback } : data;
    return this.writeRecordData(id, record, next);
  }

  async getProjectPrompt(projectId: string): Promise<string | undefined> {
    const id = assertProjectId(projectId);
    return this.readOptionalBlob(this.client.getContainerClient(id), PROJECT_PROMPT_FILE);
  }

  async getProjectConfig(projectId: string): Promise<Record<string, string>> {
    const id = assertProjectId(projectId);
    const projectEnv = await this.readOptionalBlob(this.client.getContainerClient(id), PROJECT_ENV_FILE);
    return this.mergeAzureProjectConfig(projectEnv);
  }

  async getProjectMcpConfig(projectId: string): Promise<string | undefined> {
    const id = assertProjectId(projectId);
    return this.readOptionalBlob(this.client.getContainerClient(id), PROJECT_MCP_FILE);
  }

  async getTagDefinitions(projectId: string): Promise<import('../shared/types').TagDefinition[]> {
    const id = assertProjectId(projectId);
    const projectDefinitions = await this.readOptionalJsonBlob(this.client.getContainerClient(id), PROJECT_TAGS_FILE);
    const appDefinitions = await loadManualTagDefinitionsFromDirectories([path.dirname(this.config.appEnvPath)]);
    return loadManualTagDefinitionsFromValues([projectDefinitions, appDefinitions]);
  }

  async reconcileRecordTags(projectId: string, data: unknown): Promise<ReconcileTagsResult> {
    const id = assertProjectId(projectId);
    const container = this.client.getContainerClient(id);
    const schema = JSON.parse(await this.readProjectSchemaBlob(container)) as unknown;
    const feedbackConfig = normalizeFeedbackConfig(schema, await this.readOptionalJsonBlob(container, PROJECT_CONFIG_FILE));
    const tagDefinitions = await this.getTagDefinitions(id);
    const plugins = await discoverComputedTagPlugins([path.dirname(this.config.appEnvPath)]);
    return reconcileComputedTags(schema, feedbackConfig, data, tagDefinitions, plugins);
  }

  private async readProjectSchemaBlob(container: ReturnType<BlobServiceClient['getContainerClient']>): Promise<string> {
    return this.readBlob(container, PROJECT_SCHEMA_FILE, `Project is missing required ${PROJECT_SCHEMA_FILE}.`);
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

  private async nextSchemaBackupName(container: ReturnType<BlobServiceClient['getContainerClient']>): Promise<string> {
    for (let index = 1; ; index += 1) {
      const name = `${CONFIG_DIRECTORY}/schema_${index}.json`;
      if (!(await container.getBlobClient(name).exists())) {
        return name;
      }
    }
  }

  private mergeAzureProjectConfig(projectEnv: string | undefined): Record<string, string> {
    return projectEnv
      ? { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath), ...parseAzureProjectEnv(projectEnv) }
      : { ...this.config.values, ...readRuntimeEnvValues(this.config.appEnvPath) };
  }
}

const isRecordFile = (name: string): boolean => name.endsWith('.json') && !path.basename(name).startsWith('_') && !name.includes('/');

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
          throw new Error(`Invalid project config/.env line: ${line}`);
        }
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );

export const buildRecordDetail = (projectId: string, recordId: string, schema: unknown, data: unknown, displayConfig?: FeedbackConfig): RecordDetail => {
  const coreData = stripFeedbackProperties(data);
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
