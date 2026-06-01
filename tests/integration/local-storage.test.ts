import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from '../../src/main/storage';

const fixtureRoot = path.resolve('test-fixtures/local-projects');

describe('local storage adapter', () => {
  const adapter = new LocalStorageAdapter({
    backendKind: 'local',
    appEnvPath: '.env',
    values: { LOCAL_PATH: fixtureRoot }
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
    const tempAdapter = new LocalStorageAdapter({
      backendKind: 'local',
      appEnvPath: '.env',
      values: { LOCAL_PATH: tempRoot, APP_SETTING: 'app-value' }
    });
    await fs.mkdir(path.join(tempRoot, 'env-project'));
    await fs.writeFile(path.join(tempRoot, 'env-project', '_schema.json'), '{"type":"object"}\n');
    await fs.writeFile(path.join(tempRoot, 'env-project', '.env'), 'APP_SETTING=project-value\nPROJECT_ONLY=enabled\n');

    await expect(tempAdapter.openProject('env-project')).resolves.toMatchObject({
      projectConfig: {
        LOCAL_PATH: tempRoot,
        APP_SETTING: 'project-value',
        PROJECT_ONLY: 'enabled'
      }
    });

    await fs.writeFile(path.join(tempRoot, 'env-project', '.env'), 'LOCAL_PATH=/tmp/other-root\n');
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
});
