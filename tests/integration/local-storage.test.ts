import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from '../../src/main/storage';

const fixtureRoot = path.resolve('test-fixtures/local-projects');

const readJson = async (filePath: string): Promise<unknown> => JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

describe('local storage adapter', () => {
  let tempRoot: string | undefined;
  const adapter = new LocalStorageAdapter({
    backendKind: 'local',
    appEnvPath: 'config/.env',
    values: { LOCAL_PATH: fixtureRoot }
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('lists projects as local subdirectories', async () => {
    await expect(adapter.listProjects()).resolves.toEqual([{ id: 'sample-project', name: 'sample-project' }]);
  });

  it('does not list the app-root config directory as a project', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-local-storage-'));
    await fs.mkdir(path.join(tempRoot, 'config'));
    await fs.mkdir(path.join(tempRoot, 'sample-project'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: path.join(tempRoot, 'config', '.env'),
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.listProjects()).resolves.toEqual([{ id: 'sample-project', name: 'sample-project' }]);
  });

  it('opens projects, requires schema, and discovers only record json files', async () => {
    const project = await adapter.openProject('sample-project');
    const recordIds = project.records.map((record) => record.id);
    expect(recordIds).toEqual([...recordIds].sort((a, b) => a.localeCompare(b)));
    expect(recordIds).toEqual(['invalid-record', 'valid-record']);
    expect(recordIds).not.toContain('schema');
    expect(recordIds).not.toContain('_reserved');
    expect(project.schema).toMatchObject({ type: 'object' });
  });

  it('returns record details with render tree metadata', async () => {
    const detail = await adapter.getRecord('sample-project', 'valid-record');
    expect(detail.validationIssues).toEqual([]);
    expect(detail.renderTree.kind).toBe('object');
  });

  it('reports exclusive record leases as unsupported', async () => {
    await expect(adapter.obtainExclusiveLease('sample-project', 'valid-record')).resolves.toEqual({ status: 'NOT_SUPPORTED' });
    await expect(adapter.releaseExclusiveLease('sample-project', 'valid-record')).resolves.toBeUndefined();
  });

  it('keeps local record files parseable after concurrent writes', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'write-project', 'config'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'write-project', 'config', 'schema.json'), JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }));
    await fs.writeFile(path.join(tempRoot, 'write-project', 'record-1.json'), JSON.stringify({ value: 'initial' }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await Promise.all(Array.from({ length: 20 }, (_value, index) => tempAdapter.writeRecordData('write-project', 'record-1', { value: `write-${index}` })));

    await expect(readJson(path.join(tempRoot, 'write-project', 'record-1.json'))).resolves.toEqual(
      expect.objectContaining({ value: expect.stringMatching(/^write-\d+$/) })
    );
    await expect(fs.readdir(path.join(tempRoot, 'write-project'))).resolves.not.toEqual(expect.arrayContaining([expect.stringMatching(/\\.tmp$/)]));
  });

  it('loads project-level markdown prompts', async () => {
    await expect(adapter.getProjectPrompt('sample-project')).resolves.toBe('You are a concise review assistant.\n');
  });

  it('applies project display config to record render trees', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'display-project', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'display-project', 'config', 'schema.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          turns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                request: { type: 'string' },
                response: { type: 'string' },
                evidence: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' } } } }
              }
            }
          }
        }
      })
    );
    await fs.writeFile(path.join(tempRoot, 'display-project', 'record-1.json'), JSON.stringify({ turns: [{ request: 'Question', response: 'Answer', evidence: [{ content: 'Source' }] }] }));
    await fs.writeFile(
      path.join(tempRoot, 'display-project', 'config', 'config.json'),
      JSON.stringify({
        properties: {
          '/turns/*/request': { path: '/turns/*/request', target: 'Request', tab: 'Main', feedback: 'none', comments: false, presentation: 'chat-request', edit_mode: 'none' },
          '/turns/*/response': { path: '/turns/*/response', target: 'Response', tab: 'Main', feedback: 'none', comments: false, presentation: 'chat-response', edit_mode: 'none' },
          '/turns/*/evidence': { path: '/turns/*/evidence', target: 'Evidence', tab: 'Main', feedback: 'none', comments: false, presentation: 'evidence-list' }
        }
      })
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    const detail = await tempAdapter.getRecord('display-project', 'record-1');
    const turns = detail.renderTree.kind === 'object' ? detail.renderTree.children.find((child) => child.path === '/turns') : undefined;
    const firstTurn = turns?.kind === 'array' ? turns.items[0] : undefined;
    const fields = firstTurn?.kind === 'object' ? firstTurn.children : [];

    expect(fields.find((field) => field.path === '/turns/0/request')).toMatchObject({ presentation: 'chat-request' });
    expect(fields.find((field) => field.path === '/turns/0/response')).toMatchObject({ presentation: 'chat-response' });
    expect(fields.find((field) => field.path === '/turns/0/evidence')).toMatchObject({ presentation: 'evidence-list' });
  });

  it('loads merged manual tag definitions from project and app config folders', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const appRoot = path.join(tempRoot, 'app');
    const projectsRoot = path.join(tempRoot, 'projects');
    await fs.mkdir(path.join(appRoot, 'config'), { recursive: true });
    await fs.mkdir(path.join(projectsRoot, 'tag-project', 'config'), { recursive: true });
    const appEnvPath = path.join(appRoot, 'config', '.env');
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${projectsRoot}\n`);
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'config', 'schema.json'), JSON.stringify({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }));
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'record-1.json'), JSON.stringify({ tags: ['needs-review'] }));
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'config', 'tags.json'), JSON.stringify([{ name: 'needs-review', description: 'Project definition' }]));
    await fs.writeFile(
      path.join(appRoot, 'config', 'tags.json'),
      JSON.stringify([{ name: 'needs-review', description: 'App definition' }, { name: 'approved', description: 'Approved' }])
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath,
      values: { LOCAL_PATH: projectsRoot }
    });

    await expect(tempAdapter.openProject('tag-project')).resolves.toMatchObject({
      tagDefinitions: [
        { name: 'needs-review', description: 'Project definition' },
        { name: 'approved', description: 'Approved' }
      ]
    });
  });

  it('runs computed tag plugins only from the trusted app config folder', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const appRoot = path.join(tempRoot, 'app');
    const projectsRoot = path.join(tempRoot, 'projects');
    await fs.mkdir(path.join(appRoot, 'config'), { recursive: true });
    await fs.mkdir(path.join(projectsRoot, 'tag-project', 'config'), { recursive: true });
    const appEnvPath = path.join(appRoot, 'config', '.env');
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${projectsRoot}\n`);
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'config', 'schema.json'), JSON.stringify({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }));
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'config', 'config.json'), JSON.stringify({ properties: { '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, edit_mode: 'inline', mapping: 'tags', presentation: 'tags' } } }));
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'record-1.json'), JSON.stringify({ tags: [] }));
    await fs.writeFile(path.join(projectsRoot, 'tag-project', 'config', 'evil.mjs'), 'export default { name: "project", tag(record) { record.tags.push("project-plugin"); } };');
    await fs.writeFile(path.join(appRoot, 'config', 'trusted.mjs'), 'export default { name: "trusted", tag(record) { record.tags.push("app-plugin"); } };');
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath,
      values: { LOCAL_PATH: projectsRoot }
    });

    const result = await tempAdapter.reconcileRecordTags('tag-project', { tags: [] });

    expect(result).toMatchObject({ data: { tags: ['app-plugin'] }, pluginErrors: [] });
  });

  it('rejects symlinked project config directories', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const externalConfig = path.join(tempRoot, 'external-config');
    const projectPath = path.join(tempRoot, 'symlink-project');
    await fs.mkdir(externalConfig);
    await fs.mkdir(projectPath);
    await fs.writeFile(path.join(externalConfig, 'schema.json'), JSON.stringify({ type: 'object' }));
    await fs.symlink(externalConfig, path.join(projectPath, 'config'), 'dir');
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.openProject('symlink-project')).rejects.toThrow('Project config directory cannot be a symlink');
  });

  it('rejects symlinked project config files', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const externalSchema = path.join(tempRoot, 'external-schema.json');
    const projectPath = path.join(tempRoot, 'symlink-file-project');
    await fs.mkdir(path.join(projectPath, 'config'), { recursive: true });
    await fs.writeFile(externalSchema, JSON.stringify({ type: 'object' }));
    await fs.symlink(externalSchema, path.join(projectPath, 'config', 'schema.json'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.openProject('symlink-file-project')).rejects.toThrow('Project config file cannot be a symlink: config/schema.json');
  });

  it('loads project MCP config from config/mcp.json and rejects MCP symlinks', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const projectPath = path.join(tempRoot, 'mcp-project');
    const externalMcp = path.join(tempRoot, 'external-mcp.json');
    await fs.mkdir(path.join(projectPath, 'config'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'config', 'schema.json'), JSON.stringify({ type: 'object' }));
    await fs.writeFile(path.join(projectPath, 'config', 'mcp.json'), '{"mcpServers":{"source":{"command":"source-mcp"}}}\n');
    await fs.writeFile(externalMcp, '{"mcpServers":{"external":{"command":"external-mcp"}}}\n');
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await expect(tempAdapter.getProjectMcpConfig('mcp-project')).resolves.toContain('"source"');
    await expect(tempAdapter.getProjectMcpConfig('mcp-project')).resolves.toContain('"source"');

    await fs.rm(path.join(projectPath, 'config', 'mcp.json'));
    await fs.symlink(externalMcp, path.join(projectPath, 'config', 'mcp.json'));
    await expect(tempAdapter.getProjectMcpConfig('mcp-project')).rejects.toThrow('Project config file cannot be a symlink: config/mcp.json');
  });

  it('loads project prompts from config/prompt.md and rejects prompt symlinks', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const projectPath = path.join(tempRoot, 'prompt-project');
    const externalPrompt = path.join(tempRoot, 'external-prompt.md');
    await fs.mkdir(path.join(projectPath, 'config'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'config', 'schema.json'), JSON.stringify({ type: 'object' }));
    await fs.writeFile(path.join(projectPath, 'config', 'prompt.md'), 'Project prompt\n');
    await fs.writeFile(externalPrompt, 'External prompt\n');
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.getProjectPrompt('prompt-project')).resolves.toBe('Project prompt\n');

    await fs.rm(path.join(projectPath, 'config', 'prompt.md'));
    await fs.symlink(externalPrompt, path.join(projectPath, 'config', 'prompt.md'));
    await expect(tempAdapter.getProjectPrompt('prompt-project')).rejects.toThrow('Project config file cannot be a symlink: config/prompt.md');
  });

  it('rejects symlinked project config env files', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const projectPath = path.join(tempRoot, 'env-symlink-project');
    const externalEnv = path.join(tempRoot, 'external.env');
    await fs.mkdir(path.join(projectPath, 'config'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'config', 'schema.json'), JSON.stringify({ type: 'object' }));
    await fs.writeFile(externalEnv, 'USERNAME=external@example.com\n');
    await fs.symlink(externalEnv, path.join(projectPath, 'config', '.env'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.getProjectConfig('env-symlink-project')).rejects.toThrow('Environment file cannot be a symlink');
  });

  it('rejects path traversal through IPC-facing identifiers', async () => {
    await expect(adapter.openProject('../sample-project')).rejects.toThrow('Invalid project identifier');
    await expect(adapter.getRecord('sample-project', '../valid-record')).rejects.toThrow('Invalid record identifier');
  });
});

describe('local project creation', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('saves generated project schemas while rotating existing schema backups', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await tempAdapter.createProject('schema-project');
    const projectPath = path.join(tempRoot, 'schema-project');

    const firstSchema = { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false };
    await expect(tempAdapter.saveProjectSchema('schema-project', firstSchema)).resolves.toEqual({
      projectId: 'schema-project',
      schemaPath: 'config/schema.json',
      backupSchemaPath: 'config/schema_1.json',
      schema: firstSchema
    });
    expect(await readJson(path.join(projectPath, 'config', 'schema.json'))).toEqual(firstSchema);
    expect(await readJson(path.join(projectPath, 'config', 'schema_1.json'))).toEqual({ type: 'object', properties: {}, additionalProperties: true });

    const secondSchema = { type: 'object', properties: { score: { type: 'number' } } };
    await expect(tempAdapter.saveProjectSchema('schema-project', secondSchema)).resolves.toMatchObject({ backupSchemaPath: 'config/schema_2.json' });
    expect(await readJson(path.join(projectPath, 'config', 'schema.json'))).toEqual(secondSchema);
    expect(await readJson(path.join(projectPath, 'config', 'schema_2.json'))).toEqual(firstSchema);
  });

  it('fills gaps when selecting generated schema backup names', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await tempAdapter.createProject('schema-project');
    const projectPath = path.join(tempRoot, 'schema-project');
    await fs.writeFile(path.join(projectPath, 'config', 'schema_1.json'), '{"type":"object","properties":{"old":{"type":"string"}}}\n');
    await fs.writeFile(path.join(projectPath, 'config', 'schema_3.json'), '{"type":"object","properties":{"older":{"type":"string"}}}\n');
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };

    await expect(tempAdapter.saveProjectSchema('schema-project', schema)).resolves.toMatchObject({ backupSchemaPath: 'config/schema_2.json' });
    expect(await readJson(path.join(projectPath, 'config', 'schema_2.json'))).toEqual({ type: 'object', properties: {}, additionalProperties: true });
  });

  it('saves generated schema objects without validating JSON Schema keywords', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await tempAdapter.createProject('schema-project');
    const projectPath = path.join(tempRoot, 'schema-project');
    const schema = { type: 123 };

    await expect(tempAdapter.saveProjectSchema('schema-project', schema)).resolves.toEqual({
      projectId: 'schema-project',
      schemaPath: 'config/schema.json',
      backupSchemaPath: 'config/schema_1.json',
      schema
    });

    expect(await readJson(path.join(projectPath, 'config', 'schema.json'))).toEqual(schema);
    expect(await readJson(path.join(projectPath, 'config', 'schema_1.json'))).toEqual({ type: 'object', properties: {}, additionalProperties: true });
  });

  it('normalizes feedback configuration after a generated schema changes project fields', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-schema-project', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'feedback-schema-project', 'config', 'schema.json'),
      JSON.stringify({ type: 'object', properties: { answer: { type: 'string' }, stale: { type: 'string' } } })
    );
    await fs.writeFile(
      path.join(tempRoot, 'feedback-schema-project', 'config', 'config.json'),
      JSON.stringify({
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'thumbs', comments: true, edit_mode: 'none' },
          '/stale': { path: '/stale', target: 'Stale', tab: 'Main', feedback: 'stars_5', comments: true, edit_mode: 'logged' }
        }
      })
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await tempAdapter.saveProjectSchema('feedback-schema-project', {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        confidence: { type: 'number' }
      }
    });

    const config = await tempAdapter.getFeedbackConfig('feedback-schema-project');
    expect(Object.keys(config.properties)).toEqual(['/answer', '/confidence']);
    expect(config.properties['/answer']).toMatchObject({ feedback: 'thumbs', comments: true });
    expect(config.properties['/confidence']).toMatchObject({ target: 'Confidence' });
  });

  it('creates a project folder initialized with a default schema', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.createProject('new-project')).resolves.toEqual({ id: 'new-project', name: 'new-project' });
    await expect(tempAdapter.openProject('new-project')).resolves.toMatchObject({
      project: { id: 'new-project', name: 'new-project' },
      schema: { type: 'object' },
      records: []
    });
  });

  it('loads project-level env values without allowing backend overrides', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const appEnvPath = path.join(tempRoot, 'config', '.env');
    await fs.mkdir(path.dirname(appEnvPath), { recursive: true });
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${tempRoot}\nUSERNAME=app@example.com\n`);
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath,
      values: { LOCAL_PATH: tempRoot, APP_SETTING: 'app-value', USERNAME: 'app@example.com' }
    });
    await fs.mkdir(path.join(tempRoot, 'env-project', 'config'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'env-project', 'config', 'schema.json'), '{"type":"object"}\n');
    await fs.writeFile(
      path.join(tempRoot, 'env-project', 'config', '.env'),
      'APP_SETTING=project-value\nUSERNAME=project@example.com\nPROJECT_ONLY=enabled\nSOURCE_TOKEN=secret-token\n'
    );
    await fs.writeFile(path.join(tempRoot, 'env-project', 'config', 'mcp.json'), '{"mcpServers":{"source":{"command":"source-mcp"}}}\n');

    await expect(tempAdapter.openProject('env-project')).resolves.toMatchObject({
      projectConfig: {
        LOCAL_PATH: tempRoot,
        APP_SETTING: 'project-value',
        USERNAME: 'project@example.com',
        PROJECT_ONLY: 'enabled',
        SOURCE_TOKEN: '****'
      }
    });
    await expect(tempAdapter.getProjectConfig('env-project')).resolves.toMatchObject({ SOURCE_TOKEN: 'secret-token' });
    await expect(tempAdapter.getProjectMcpConfig('env-project')).resolves.toContain('"source"');
    await expect(tempAdapter.getProjectUser('env-project')).resolves.toEqual({ username: 'project@example.com', valid: true });

    await fs.writeFile(path.join(tempRoot, 'env-project', 'config', '.env'), '');
    await expect(tempAdapter.openProject('env-project')).resolves.toMatchObject({
      projectConfig: {
        LOCAL_PATH: tempRoot,
        USERNAME: 'app@example.com'
      }
    });
    await expect(tempAdapter.getProjectUser('env-project')).resolves.toEqual({ username: 'app@example.com', valid: true });

    await fs.writeFile(path.join(tempRoot, 'env-project', 'config', '.env'), 'LOCAL_PATH=/tmp/other-root\nUSERNAME=sme@example.com\n');
    await expect(tempAdapter.openProject('env-project')).rejects.toThrow('Project config/.env cannot override backend selection keys');
  });

  it('fails clearly when a project is missing the required schema', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await fs.mkdir(path.join(tempRoot, 'missing-schema'));

    await expect(tempAdapter.openProject('missing-schema')).rejects.toThrow('Project is missing required config/schema.json.');
  });

  it('rejects names that cannot be used for Azure containers', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.createProject('Bad Name')).rejects.toThrow('Project name must be 3-63 characters');
  });

  it('loads, saves, and sanitizes schema-derived feedback configuration', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-project', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', 'config', 'schema.json'),
      JSON.stringify({ type: 'object', properties: { answer: { type: 'string' }, request: { type: 'object', properties: { query: { type: 'string' } } } } })
    );
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', 'config', 'config.json'),
      JSON.stringify({
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'good_fair_bad', comments: true, edit_mode: 'none' },
          '/stale': { path: '/stale', target: 'Stale', tab: 'Main', feedback: 'stars_5', comments: true, edit_mode: 'logged' }
        }
      })
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: 'config/.env',
      values: { LOCAL_PATH: tempRoot }
    });

    const config = await tempAdapter.getFeedbackConfig('feedback-project');
    expect(Object.keys(config.properties)).toEqual(['/answer', '/request', '/request/query']);
    expect(config.properties['/answer']).toMatchObject({ feedback: 'good_fair_bad', comments: true });
    expect(config.properties['/stale']).toBeUndefined();

    const saved = await tempAdapter.saveFeedbackConfig('feedback-project', {
      properties: {
        ...config.properties,
        '/request/query': { ...config.properties['/request/query'], feedback: 'stars_5', editMode: 'inline' }
      }
    });
    expect(saved.properties['/request/query']).toMatchObject({ feedback: 'stars_5', editMode: 'inline' });
  });

  it('submits feedback with reloaded USERNAME and preserves feedback during core updates', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const appEnvPath = path.join(tempRoot, 'config', '.env');
    await fs.mkdir(path.dirname(appEnvPath), { recursive: true });
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${tempRoot}\nUSERNAME=initial@example.com\n`);
    await fs.mkdir(path.join(tempRoot, 'feedback-project', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', 'config', 'schema.json'),
      JSON.stringify({ type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] })
    );
    await fs.writeFile(path.join(tempRoot, 'feedback-project', 'record-1.json'), JSON.stringify({ answer: 'Original' }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath,
      values: { LOCAL_PATH: tempRoot, USERNAME: 'initial@example.com' }
    });
    const config = await tempAdapter.getFeedbackConfig('feedback-project');
    await tempAdapter.saveFeedbackConfig('feedback-project', {
      properties: {
        ...config.properties,
        '/answer': { ...config.properties['/answer'], feedback: 'good_fair_bad', comments: true, editMode: 'logged' }
      }
    });

    await fs.writeFile(appEnvPath, `LOCAL_PATH=${tempRoot}\nUSERNAME=updated@example.com\n`);
    await expect(tempAdapter.getProjectUser('feedback-project')).resolves.toEqual({ username: 'updated@example.com', valid: true });
    const submitted = await tempAdapter.submitFeedback('feedback-project', 'record-1', {
      propertyPath: '/answer',
      feedbackValue: 'good',
      commentValue: 'Clear',
      editValue: 'Updated answer'
    });

    expect(submitted.username).toBe('updated@example.com');
    expect(submitted.record.data).toEqual({ answer: 'Updated answer' });
    expect(submitted.record.validationIssues).toEqual([]);
    expect(submitted.record.feedbackHistory?.['/answer'].original).toBe('Original');
    expect(submitted.record.feedbackHistory?.['/answer'].feedback[0]).toMatchObject({ value: 'good', username: 'updated@example.com' });
    const stored = JSON.parse(await fs.readFile(path.join(tempRoot, 'feedback-project', 'record-1.json'), 'utf8')) as Record<string, unknown>;
    expect(stored.answer).toBe('Updated answer');
    expect(stored._feedback_answer).toMatchObject([{ original: 'Original' }, { edit: 'Updated answer', username: 'updated@example.com' }]);

    const updated = await tempAdapter.updateRecord('feedback-project', 'record-1', { answer: 'Core update' });
    expect(updated.data).toEqual({ answer: 'Core update' });
    expect(updated.feedbackHistory?.['/answer'].comments[0]).toMatchObject({ value: 'Clear', username: 'updated@example.com' });
  });

  it('creates a record only when saving a new-record draft against an empty slot', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'draft-project', 'config'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'draft-project', 'config', 'schema.json'), JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } } }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: path.join(tempRoot, 'config', '.env'),
      values: { LOCAL_PATH: tempRoot }
    });

    const saved = await tempAdapter.writeRecordDataIfUnchanged('draft-project', 'new-record', { answer: 'Draft answer' }, undefined);

    expect(saved.data).toEqual({ answer: 'Draft answer' });
    await expect(fs.readFile(path.join(tempRoot, 'draft-project', 'new-record.json'), 'utf8')).resolves.toContain('Draft answer');
    await expect(
      tempAdapter.writeRecordDataIfUnchanged('draft-project', 'new-record', { answer: 'Overwritten' }, undefined)
    ).rejects.toThrow('Record changed after this draft was staged');
  });

  it('submits feedback to schema-derived array item properties', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-project', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', 'config', 'schema.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string' }
              }
            }
          }
        }
      })
    );
    await fs.writeFile(path.join(tempRoot, 'feedback-project', 'record-1.json'), JSON.stringify({ evidence: [{ id: 'doc-1', source: 'docs' }] }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: path.join(tempRoot, 'config', '.env'),
      values: { LOCAL_PATH: tempRoot, USERNAME: 'sme@example.com' }
    });
    const config = await tempAdapter.getFeedbackConfig('feedback-project');
    await tempAdapter.saveFeedbackConfig('feedback-project', {
      properties: {
        ...config.properties,
        '/evidence/*/id': { ...config.properties['/evidence/*/id'], feedback: 'thumbs', comments: true }
      }
    });

    const submitted = await tempAdapter.submitFeedback('feedback-project', 'record-1', {
      propertyPath: '/evidence/0/id',
      feedbackValue: 'up',
      commentValue: 'Relevant source'
    });

    expect(submitted.record.feedbackHistory?.['/evidence/0/id'].feedback[0]).toMatchObject({ value: 'up', username: 'sme@example.com' });
    expect(submitted.record.feedbackHistory?.['/evidence/0/id'].comments[0]).toMatchObject({ value: 'Relevant source', username: 'sme@example.com' });
  });

  it('blocks feedback submission when USERNAME is missing', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-project', 'config'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'feedback-project', 'config', 'schema.json'), JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } } }));
    await fs.writeFile(path.join(tempRoot, 'feedback-project', 'record-1.json'), JSON.stringify({ answer: 'Original' }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: path.join(tempRoot, 'config', '.env'),
      values: { LOCAL_PATH: tempRoot }
    });
    const config = await tempAdapter.getFeedbackConfig('feedback-project');
    await tempAdapter.saveFeedbackConfig('feedback-project', {
      properties: { ...config.properties, '/answer': { ...config.properties['/answer'], feedback: 'good_fair_bad' } }
    });

    await expect(
      tempAdapter.submitFeedback('feedback-project', 'record-1', { propertyPath: '/answer', feedbackValue: 'good' })
    ).rejects.toThrow('USERNAME environment variable not configured');
  });
});
