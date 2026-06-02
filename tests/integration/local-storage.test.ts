import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from '../../src/main/storage';

const fixtureRoot = path.resolve('test-fixtures/local-projects');

describe('local storage adapter', () => {
  let tempRoot: string | undefined;
  const adapter = new LocalStorageAdapter({
    backendKind: 'local',
    appEnvPath: '.env',
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

  it('opens projects, requires schema, and discovers only record json files', async () => {
    const project = await adapter.openProject('sample-project');
    const recordIds = project.records.map((record) => record.id);
    expect(recordIds).toEqual([...recordIds].sort((a, b) => a.localeCompare(b)));
    expect(recordIds).toEqual(['invalid-record', 'valid-record']);
    expect(recordIds).not.toContain('_schema');
    expect(recordIds).not.toContain('_reserved');
    expect(project.schema).toMatchObject({ type: 'object' });
  });

  it('returns record details with schema validation and render tree', async () => {
    const detail = await adapter.getRecord('sample-project', 'valid-record');
    expect(detail.validationIssues).toEqual([]);
    expect(detail.renderTree.kind).toBe('object');
  });

  it('applies project display config to record render trees', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'display-project'));
    await fs.writeFile(
      path.join(tempRoot, 'display-project', '_schema.json'),
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
      path.join(tempRoot, 'display-project', '_display.json'),
      JSON.stringify({
        properties: {
          '/turns/*/request': { path: '/turns/*/request', presentation: 'chat-request' },
          '/turns/*/response': { path: '/turns/*/response', presentation: 'chat-response' },
          '/turns/*/evidence': { path: '/turns/*/evidence', presentation: 'evidence-list' }
        }
      })
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
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

  it('creates a project folder initialized with a default schema', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
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
    const appEnvPath = path.join(tempRoot, 'app.env');
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${tempRoot}\nUSERNAME=app@example.com\n`);
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath,
      values: { LOCAL_PATH: tempRoot, APP_SETTING: 'app-value', USERNAME: 'app@example.com' }
    });
    await fs.mkdir(path.join(tempRoot, 'env-project'));
    await fs.writeFile(path.join(tempRoot, 'env-project', '_schema.json'), '{"type":"object"}\n');
    await fs.writeFile(
      path.join(tempRoot, 'env-project', '.env'),
      'APP_SETTING=project-value\nUSERNAME=project@example.com\nPROJECT_ONLY=enabled\nSOURCE_TOKEN=secret-token\n'
    );
    await fs.writeFile(path.join(tempRoot, 'env-project', '_mcp.json'), '{"mcpServers":{"source":{"command":"source-mcp"}}}\n');

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

    await fs.writeFile(path.join(tempRoot, 'env-project', '.env'), '');
    await expect(tempAdapter.openProject('env-project')).resolves.toMatchObject({
      projectConfig: {
        LOCAL_PATH: tempRoot,
        USERNAME: 'app@example.com'
      }
    });
    await expect(tempAdapter.getProjectUser('env-project')).resolves.toEqual({ username: 'app@example.com', valid: true });

    await fs.writeFile(path.join(tempRoot, 'env-project', '.env'), 'LOCAL_PATH=/tmp/other-root\nUSERNAME=sme@example.com\n');
    await expect(tempAdapter.openProject('env-project')).rejects.toThrow('Project .env cannot override backend selection keys');
  });

  it('fails clearly when a project is missing the required schema', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
      values: { LOCAL_PATH: tempRoot }
    });
    await fs.mkdir(path.join(tempRoot, 'missing-schema'));

    await expect(tempAdapter.openProject('missing-schema')).rejects.toThrow('Project is missing required _schema.json.');
  });

  it('rejects names that cannot be used for Azure containers', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
      values: { LOCAL_PATH: tempRoot }
    });

    await expect(tempAdapter.createProject('Bad Name')).rejects.toThrow('Project name must be 3-63 characters');
  });

  it('loads, saves, and sanitizes schema-derived feedback configuration', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-project'));
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', '_schema.json'),
      JSON.stringify({ type: 'object', properties: { answer: { type: 'string' }, request: { type: 'object', properties: { query: { type: 'string' } } } } })
    );
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', '_feedback.json'),
      JSON.stringify({
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'good_fair_bad', comments: true, editable: false },
          '/stale': { path: '/stale', target: 'Stale', tab: 'Main', feedback: 'stars_5', comments: true, editable: true }
        }
      })
    );
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
      values: { LOCAL_PATH: tempRoot }
    });

    const config = await tempAdapter.getFeedbackConfig('feedback-project');
    expect(Object.keys(config.properties)).toEqual(['/answer', '/request', '/request/query']);
    expect(config.properties['/answer']).toMatchObject({ feedback: 'good_fair_bad', comments: true });
    expect(config.properties['/stale']).toBeUndefined();

    const saved = await tempAdapter.saveFeedbackConfig('feedback-project', {
      properties: {
        ...config.properties,
        '/request/query': { ...config.properties['/request/query'], feedback: 'stars_5', editable: true }
      }
    });
    expect(saved.properties['/request/query']).toMatchObject({ feedback: 'stars_5', editable: true });
  });

  it('submits feedback with reloaded USERNAME and preserves feedback during core updates', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    const appEnvPath = path.join(tempRoot, 'app.env');
    await fs.writeFile(appEnvPath, `LOCAL_PATH=${tempRoot}\nUSERNAME=initial@example.com\n`);
    await fs.mkdir(path.join(tempRoot, 'feedback-project'));
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', '_schema.json'),
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
        '/answer': { ...config.properties['/answer'], feedback: 'good_fair_bad', comments: true, editable: true }
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
    expect(stored.answer_feedback).toMatchObject([{ original: 'Original' }, { edit: 'Updated answer', username: 'updated@example.com' }]);

    const updated = await tempAdapter.updateRecord('feedback-project', 'record-1', { answer: 'Core update' });
    expect(updated.data).toEqual({ answer: 'Core update' });
    expect(updated.feedbackHistory?.['/answer'].comments[0]).toMatchObject({ value: 'Clear', username: 'updated@example.com' });
  });

  it('submits feedback to schema-derived array item properties', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-'));
    await fs.mkdir(path.join(tempRoot, 'feedback-project'));
    await fs.writeFile(
      path.join(tempRoot, 'feedback-project', '_schema.json'),
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
      appEnvPath: path.join(tempRoot, 'app.env'),
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
    await fs.mkdir(path.join(tempRoot, 'feedback-project'));
    await fs.writeFile(path.join(tempRoot, 'feedback-project', '_schema.json'), JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } } }));
    await fs.writeFile(path.join(tempRoot, 'feedback-project', 'record-1.json'), JSON.stringify({ answer: 'Original' }));
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: path.join(tempRoot, 'missing.env'),
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
