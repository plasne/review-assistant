import { describe, expect, it } from 'vitest';
import { createLocalToolRuntime, type LocalToolPlugin } from '../../src/main/tools';
import type { StorageAdapter } from '../../src/main/storage';

const storage: StorageAdapter = {
  listProjects: async () => [],
  createProject: async (projectId) => ({ id: projectId, name: projectId }),
  openProject: async (projectId) => ({ project: { id: projectId, name: projectId }, schema: {}, records: [], projectConfig: {} }),
  getProjectPrompt: async () => undefined,
  getFeedbackConfig: async () => ({ properties: {} }),
  saveFeedbackConfig: async (_projectId, config) => config,
  getProjectUser: async () => ({ username: 'sme@example.com', valid: true }),
  submitFeedback: async (projectId, recordId) => ({
    username: 'sme@example.com',
    record: await storage.getRecord(projectId, recordId)
  }),
  updateRecord: async (projectId, recordId) => storage.getRecord(projectId, recordId),
  getProjectConfig: async () => ({}),
  getProjectMcpConfig: async () => undefined,
  getRecord: async (projectId, recordId) => ({
    projectId,
    recordId,
    displayName: recordId,
    data: {
      question: 'How do I run the harness?',
      question_feedback: [{ value: 'good', username: 'sme@example.com', timestamp: '2026-06-01T14:32:15.000Z' }]
    },
    schema: { type: 'object' },
    validationIssues: [],
    renderTree: { kind: 'object', label: 'record', children: [], validationIssues: [] }
  })
};

const searchResultSchema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    evidence: {
      type: 'array',
      description: 'Evidence for the answer.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          uri: { type: 'string', format: 'uri' },
          content: { type: 'string' }
        },
        required: ['id', 'source', 'uri', 'content'],
        additionalProperties: false
      }
    },
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          references: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                uri: { type: 'string', format: 'uri' }
              },
              required: ['title', 'uri'],
              additionalProperties: false
            }
          }
        }
      }
    }
  },
  required: ['question', 'evidence'],
  additionalProperties: false
};

const createSearchResultStorage = (): { adapter: StorageAdapter; getData: () => unknown } => {
  let data: unknown = {
    question: 'How do I run the harness?',
    evidence: [
      {
        id: 'doc-1',
        source: 'README',
        uri: 'https://example.com/readme',
        content: 'Run npm run check.'
      }
    ],
    turns: [{ references: [] }]
  };
  const adapter: StorageAdapter = {
    ...storage,
    getRecord: async (projectId, recordId) => ({
      projectId,
      recordId,
      displayName: recordId,
      data: clone(data),
      schema: searchResultSchema,
      validationIssues: [],
      renderTree: { kind: 'object', label: 'record', children: [], validationIssues: [] }
    }),
    updateRecord: async (projectId, recordId, nextData) => {
      data = clone(nextData);
      return adapter.getRecord(projectId, recordId);
    }
  };
  return { adapter, getData: () => clone(data) };
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
          expect.objectContaining({ name: 'getRecordContainerSchema', source: 'built-in' }),
          expect.objectContaining({ name: 'saveSearchResults', source: 'built-in' }),
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

  it('lists selected-record array containers and returns schema for a requested destination', async () => {
    const { adapter } = createSearchResultStorage();
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(runtime.execute({ tool: 'getRecordContainerSchema', requestId: 'tool-request-1', arguments: {} })).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        containers: expect.arrayContaining([
          expect.objectContaining({ path: '/evidence', itemCount: 1, description: 'Evidence for the answer.' }),
          expect.objectContaining({ path: '/turns', itemCount: 1 }),
          expect.objectContaining({ path: '/turns/0/references', itemCount: 0 })
        ])
      }
    });

    await expect(
      runtime.execute({ tool: 'getRecordContainerSchema', requestId: 'tool-request-2', arguments: { containerPath: '/turns/0/references' } })
    ).resolves.toMatchObject({
      requestId: 'tool-request-2',
      ok: true,
      result: {
        container: {
          path: '/turns/0/references',
          itemSchema: {
            required: ['title', 'uri']
          },
          currentValue: []
        }
      }
    });
  });

  it('saves valid search results into the selected record container after schema validation', async () => {
    const { adapter, getData } = createSearchResultStorage();
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'saveSearchResults',
        requestId: 'tool-request-1',
        arguments: {
          containerPath: '/evidence',
          results: [
            {
              id: 'doc-2',
              source: 'Docs',
              uri: 'https://example.com/docs',
              content: 'Use make check for local verification.'
            }
          ],
          mode: 'append'
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        containerPath: '/evidence',
        mode: 'append',
        savedItemCount: 1,
        containerItemCount: 2
      }
    });
    expect(getData()).toMatchObject({
      evidence: [
        { id: 'doc-1' },
        {
          id: 'doc-2',
          source: 'Docs',
          uri: 'https://example.com/docs',
          content: 'Use make check for local verification.'
        }
      ]
    });
  });

  it('rejects search results that do not satisfy the destination container schema', async () => {
    const { adapter, getData } = createSearchResultStorage();
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'saveSearchResults',
        requestId: 'tool-request-1',
        arguments: {
          containerPath: '/evidence',
          results: [{ id: 'doc-2', source: 'Docs', content: 'Missing uri.' }],
          mode: 'append'
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: expect.stringContaining('must have required property')
      }
    });
    expect(getData()).toMatchObject({ evidence: [{ id: 'doc-1' }] });
  });
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
