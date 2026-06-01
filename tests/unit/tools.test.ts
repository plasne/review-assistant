import { describe, expect, it } from 'vitest';
import { createLocalToolRuntime, type LocalToolPlugin } from '../../src/main/tools';
import type { StorageAdapter } from '../../src/main/storage';

const storage: StorageAdapter = {
  listProjects: async () => [],
  createProject: async (projectId) => ({ id: projectId, name: projectId }),
  openProject: async (projectId) => ({ project: { id: projectId, name: projectId }, schema: {}, records: [], projectConfig: {} }),
  getProjectPrompt: async () => undefined,
  getRecord: async (projectId, recordId) => ({
    projectId,
    recordId,
    displayName: recordId,
    data: { question: 'How do I run the harness?' },
    schema: { type: 'object' },
    validationIssues: [],
    renderTree: { kind: 'object', label: 'record', children: [], validationIssues: [] }
  })
};

describe('local tool runtime', () => {
  it('reports built-in tool capabilities without active-state fields', () => {
    const runtime = createLocalToolRuntime({ storage, selectedProjectId: 'sample-project' });

    expect(runtime.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'readRecord',
          source: 'built-in',
          description: 'Read the record currently selected in the Review Assistant UI. Project and record identifiers always come from trusted UI state.'
        }),
        expect.objectContaining({ name: 'listTools', source: 'built-in', description: 'List Review Assistant local tools.' })
      ])
    );
  });

  it('returns a no-record response when readRecord is called without a displayed record', async () => {
    const runtime = createLocalToolRuntime({ storage });

    await expect(runtime.execute({ tool: 'readRecord', requestId: 'tool-request-1', arguments: {} })).resolves.toEqual({
      requestId: 'tool-request-1',
      ok: false,
      error: {
        code: 'NO_RECORD_SELECTED',
        message: 'No record is currently displayed in the UI.',
        retryable: false
      }
    });
  });

  it('exposes a built-in listTools tool with capability details', async () => {
    const runtime = createLocalToolRuntime({ storage, selectedProjectId: 'sample-project' });

    await expect(runtime.execute({ tool: 'listTools', requestId: 'tool-request-1', arguments: {} })).resolves.toEqual({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'readRecord', source: 'built-in' }),
          expect.objectContaining({ name: 'listTools', source: 'built-in' })
        ])
      }
    });
  });

  it('lists readRecord whenever storage context is available even without a selected record', () => {
    const runtime = createLocalToolRuntime({ storage, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    expect(runtime.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'readRecord',
          source: 'built-in'
        })
      ])
    );
  });

  it('reads the trusted UI-selected record and ignores record identifiers from tool arguments', async () => {
    const runtime = createLocalToolRuntime({ storage, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'readRecord',
        requestId: 'tool-request-1',
        arguments: { projectId: 'attacker-project', recordId: 'attacker-record', includeSchema: true }
      })
    ).resolves.toEqual({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        projectId: 'sample-project',
        recordId: 'valid-record',
        contentType: 'application/json',
        record: { question: 'How do I run the harness?' },
        schema: { type: 'object' }
      }
    });
  });

  it('exposes plugin tools through the same provider-neutral registry', async () => {
    const plugin: LocalToolPlugin = {
      id: 'sample-plugin',
      tools: [
        {
          name: 'pluginEcho',
          description: 'Echoes plugin input.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
          execute: async (request) => ({ requestId: request.requestId, ok: true, result: request.arguments })
        }
      ]
    };
    const runtime = createLocalToolRuntime({ storage }, [plugin]);

    expect(runtime.listTools()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pluginEcho', source: 'plugin', pluginId: 'sample-plugin' })])
    );
    await expect(runtime.execute({ tool: 'pluginEcho', requestId: 'plugin-request-1', arguments: { value: 'hello' } })).resolves.toEqual({
      requestId: 'plugin-request-1',
      ok: true,
      result: { value: 'hello' }
    });
  });
});
