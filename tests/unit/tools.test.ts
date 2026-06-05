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
  saveProjectSchema: async (projectId, schema) => ({ projectId, schemaPath: 'config/schema.json', schema }),
  getProjectUser: async () => ({ username: 'sme@example.com', valid: true }),
  submitFeedback: async (projectId, recordId) => ({
    username: 'sme@example.com',
    record: await storage.getRecord(projectId, recordId)
  }),
  updateRecord: async (projectId, recordId) => storage.getRecord(projectId, recordId),
  getProjectConfig: async () => ({}),
  getProjectMcpConfig: async () => undefined,
  getTagDefinitions: async () => [],
  reconcileRecordTags: async (_projectId, data) => ({ data, pluginErrors: [] }),
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

const createRecordStorage = (schema: unknown, initialData: unknown): { adapter: StorageAdapter; getData: () => unknown } => {
  let data = clone(initialData);
  const adapter: StorageAdapter = {
    ...storage,
    getRecord: async (projectId, recordId) => ({
      projectId,
      recordId,
      displayName: recordId,
      data: clone(data),
      schema,
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
          description: expect.stringContaining('Use this before answering questions about selected-record content')
        }),
        expect.objectContaining({
          name: 'saveSearchResults',
          source: 'built-in',
          description: expect.stringContaining('do not use it for turn evidence when completeTurn can save evidence')
        }),
        expect.objectContaining({
          name: 'startTurn',
          source: 'built-in',
          description: expect.stringContaining('after calling startTurn, call completeTurn before the final answer')
        }),
        expect.objectContaining({
          name: 'completeTurn',
          source: 'built-in',
          description: expect.stringContaining('role/message history arrays it appends an assistant message')
        }),
        expect.objectContaining({ name: 'listTools', source: 'built-in', description: expect.stringContaining('input schemas') })
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
          expect.objectContaining({ name: 'getRecordSchema', source: 'built-in' }),
          expect.objectContaining({ name: 'discoverCanonicalSchemaMappings', source: 'built-in' }),
          expect.objectContaining({ name: 'saveGeneratedSchema', source: 'built-in' }),
          expect.objectContaining({ name: 'saveSearchResults', source: 'built-in' }),
          expect.objectContaining({ name: 'startTurn', source: 'built-in' }),
          expect.objectContaining({ name: 'completeTurn', source: 'built-in' }),
          expect.objectContaining({ name: 'listTools', source: 'built-in' })
        ])
      }
    });
  });

  it('saves a generated schema for the selected project without requiring a selected record', async () => {
    const savedSchemas: unknown[] = [];
    const adapter: StorageAdapter = {
      ...storage,
      saveProjectSchema: async (projectId, schema) => {
        savedSchemas.push(clone(schema));
        return { projectId, schemaPath: 'config/schema.json', backupSchemaPath: 'config/schema_1.json', schema };
      }
    };
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project' });
    const schema = {
      type: 'object',
      properties: {
        question: { type: 'string' }
      },
      required: ['question'],
      additionalProperties: false
    };

    await expect(runtime.execute({ tool: 'saveGeneratedSchema', requestId: 'tool-request-1', arguments: { schema } })).resolves.toEqual({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        projectId: 'sample-project',
        schemaPath: 'config/schema.json',
        backupSchemaPath: 'config/schema_1.json',
        schema
      }
    });
    expect(savedSchemas).toEqual([schema]);
  });

  it('rejects generated schema saves without a selected project or with invalid schema input', async () => {
    await expect(createLocalToolRuntime({ storage }).execute({ tool: 'saveGeneratedSchema', requestId: 'tool-request-1', arguments: { schema: {} } })).resolves.toEqual({
      requestId: 'tool-request-1',
      ok: false,
      error: {
        code: 'NO_PROJECT_SELECTED',
        message: 'No project is currently selected in the UI.',
        retryable: false
      }
    });

    const runtime = createLocalToolRuntime({ storage, selectedProjectId: 'sample-project' });
    await expect(runtime.execute({ tool: 'saveGeneratedSchema', requestId: 'tool-request-2', arguments: { schema: [] } })).resolves.toEqual({
      requestId: 'tool-request-2',
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'schema must be a JSON Schema object.',
        retryable: false
      }
    });
    await expect(runtime.execute({ tool: 'saveGeneratedSchema', requestId: 'tool-request-3', arguments: { schema: { type: 123 } } })).resolves.toMatchObject({
      requestId: 'tool-request-3',
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        retryable: false
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

  it('discovers canonical mapping candidates from the selected record schema', async () => {
    const { adapter } = createSearchResultStorage();
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(runtime.execute({ tool: 'discoverCanonicalSchemaMappings', requestId: 'tool-request-1', arguments: {} })).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        turns: { candidates: expect.arrayContaining([expect.objectContaining({ path: '/turns' })]) },
        request: { candidates: expect.arrayContaining([expect.objectContaining({ path: '/question', schema: { type: 'string' } })]) },
        response: { candidates: [] },
        evidence: {
          candidates: expect.arrayContaining([
            expect.objectContaining({ path: '/evidence' }),
            expect.objectContaining({ path: '/turns/*/references' })
          ])
        },
        facts: { candidates: [] },
        tags: { candidates: [] }
      }
    });
  });

  it('uses explicit canonical mappings to narrow discovery candidates', async () => {
    const { adapter } = createSearchResultStorage();
    const mappedAdapter: StorageAdapter = {
      ...adapter,
      getFeedbackConfig: async () => ({
        properties: {
          '/turns': { path: '/turns', target: 'Turns', tab: 'Main', feedback: 'none', comments: false, mapping: 'turns' },
          '/turns/*/references': {
            path: '/turns/*/references',
            target: 'References',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            mapping: 'evidence'
          }
        }
      })
    };
    const runtime = createLocalToolRuntime({ storage: mappedAdapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(runtime.execute({ tool: 'discoverCanonicalSchemaMappings', requestId: 'tool-request-2', arguments: {} })).resolves.toMatchObject({
      requestId: 'tool-request-2',
      ok: true,
      result: {
        turns: { candidates: [{ path: '/turns', schema: expect.objectContaining({ type: 'array' }) }] },
        evidence: { candidates: [{ path: '/turns/*/references', schema: expect.objectContaining({ type: 'array' }) }] },
        request: { candidates: [] }
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
        message: expect.stringContaining('Missing required field: uri')
      }
    });
    expect(getData()).toMatchObject({ evidence: [{ id: 'doc-1' }] });
  });

  it('saves search results without being blocked by unrelated root validation issues', async () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        persona: { type: 'string', enum: ['TPM', 'developer', 'SME'] },
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' },
              evidence: {
                type: 'array',
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
              }
            },
            required: ['request', 'response', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['id', 'persona', 'turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { turns: [{ request: 'Where is dial?', response: '', evidence: [] }] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'q101' });

    await expect(
      runtime.execute({
        tool: 'saveSearchResults',
        requestId: 'tool-request-1',
        arguments: {
          containerPath: '/turns/0/evidence',
          results: [
            {
              id: 'dial-1',
              source: 'GitHub',
              uri: 'https://example.com/dial',
              content: 'Dial functionality appears in the service.'
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        containerPath: '/turns/0/evidence',
        savedItemCount: 1,
        containerItemCount: 1
      }
    });
    expect(getData()).toEqual({
      turns: [
        {
          request: 'Where is dial?',
          response: '',
          evidence: [
            {
              id: 'dial-1',
              source: 'GitHub',
              uri: 'https://example.com/dial',
              content: 'Dial functionality appears in the service.'
            }
          ]
        }
      ]
    });
  });

  it('rejects nested search result destinations when intermediate array data is absent', async () => {
    const schema = {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              evidence: {
                type: 'array',
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
              }
            },
            required: ['evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, {});
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'q101' });

    await expect(
      runtime.execute({
        tool: 'saveSearchResults',
        requestId: 'tool-request-1',
        arguments: {
          containerPath: '/turns/0/evidence',
          results: [
            {
              id: 'dial-1',
              source: 'GitHub',
              uri: 'https://example.com/dial',
              content: 'Dial functionality appears in the service.'
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'Record path /turns/0/evidence does not exist.'
      }
    });
    expect(getData()).toEqual({});
  });

  it('returns full schema and turn candidates that may not exist in current record data', async () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conversation: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' }
            },
            required: ['request', 'response'],
            additionalProperties: false
          }
        }
      },
      required: ['id'],
      additionalProperties: false
    };
    const { adapter } = createRecordStorage(schema, { id: 'record-1' });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(runtime.execute({ tool: 'getRecordSchema', requestId: 'tool-request-1', arguments: {} })).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        schema,
        turnCandidates: expect.arrayContaining([
          expect.objectContaining({
            path: '/conversation',
            mode: 'append',
            fields: { inquiryField: 'request', responseField: 'response' }
          })
        ])
      }
    });
  });

  it('creates a turn by inferring an array target from the project schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        conversation: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              utterance: { type: 'string' },
              completion: { type: 'string' }
            },
            required: ['utterance', 'completion'],
            additionalProperties: false
          }
        }
      },
      required: ['conversation'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { conversation: [] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'startTurn',
        requestId: 'tool-request-1',
        arguments: { inquiry: 'What failed?', response: 'The smoke gate failed.' }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        targetPath: '/conversation',
        mode: 'append',
        fields: { inquiryField: 'utterance', responseField: 'completion' },
        turnIndex: 0
      }
    });
    expect(getData()).toEqual({ conversation: [{ utterance: 'What failed?', completion: 'The smoke gate failed.' }] });
  });

  it('creates a pending turn with explicit target and field mapping for custom schemas', async () => {
    const schema = {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              humanSaid: { type: 'string' },
              machineSaid: { type: 'string' },
              reviewed: { type: 'boolean' }
            },
            required: ['humanSaid', 'machineSaid', 'reviewed'],
            additionalProperties: false
          }
        }
      },
      required: ['turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { turns: [] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'startTurn',
        requestId: 'tool-request-1',
        arguments: {
          targetPath: '/turns',
          fieldMapping: { inquiryField: 'humanSaid', responseField: 'machineSaid' },
          additionalFields: { reviewed: false },
          inquiry: 'Can we ship?'
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        targetPath: '/turns',
        fields: { inquiryField: 'humanSaid', responseField: 'machineSaid' },
        turnIndex: 0
      }
    });
    expect(getData()).toEqual({ turns: [{ humanSaid: 'Can we ship?', machineSaid: '', reviewed: false }] });
  });

  it('sets a response on an existing pending turn after the agent computes it', async () => {
    const schema = {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' },
              evidence: {
                type: 'array',
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
              }
            },
            required: ['request', 'response', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { turns: [{ request: 'What changed?', response: '', evidence: [] }] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'completeTurn',
        requestId: 'tool-request-1',
        arguments: {
          targetPath: '/turns',
          turnIndex: 0,
          response: 'The turn workflow now stores the inquiry first and response later.',
          evidence: [
            {
              id: 'turn-tool',
              source: 'Tool tests',
              uri: 'https://example.com/tools',
              content: 'completeTurn accepts evidence with the response.'
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        targetPath: '/turns/0',
        responseField: 'response',
        evidenceField: 'evidence',
        savedEvidenceCount: 1,
        turn: {
          request: 'What changed?',
          response: 'The turn workflow now stores the inquiry first and response later.',
          evidence: [
            {
              id: 'turn-tool',
              source: 'Tool tests',
              uri: 'https://example.com/tools',
              content: 'completeTurn accepts evidence with the response.'
            }
          ]
        }
      }
    });
    expect(getData()).toEqual({
      turns: [
        {
          request: 'What changed?',
          response: 'The turn workflow now stores the inquiry first and response later.',
          evidence: [
            {
              id: 'turn-tool',
              source: 'Tool tests',
              uri: 'https://example.com/tools',
              content: 'completeTurn accepts evidence with the response.'
            }
          ]
        }
      ]
    });
  });

  it('sets a response on a specific turn in a multi-turn conversation', async () => {
    const schema = {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' }
            },
            required: ['request', 'response'],
            additionalProperties: false
          }
        }
      },
      required: ['turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, {
      turns: [
        { request: 'First question?', response: '' },
        { request: 'Second question?', response: '' }
      ]
    });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'completeTurn',
        requestId: 'tool-request-1',
        arguments: {
          targetPath: '/turns',
          turnIndex: 0,
          response: 'First answer.'
        }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        targetPath: '/turns/0',
        turn: { request: 'First question?', response: 'First answer.' }
      }
    });
    expect(getData()).toEqual({
      turns: [
        { request: 'First question?', response: 'First answer.' },
        { request: 'Second question?', response: '' }
      ]
    });
  });

  it('appends assistant messages for role/message history arrays without overwriting the user message', async () => {
    const schema = {
      type: 'object',
      properties: {
        history: {
          type: 'array',
          description: 'Conversation history turns',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'msg'],
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system'] },
              msg: { type: 'string' }
            }
          }
        }
      },
      required: ['history'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { history: [] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'startTurn',
        requestId: 'tool-request-1',
        arguments: { targetPath: '/history', inquiry: 'Which services contain dial functionality?' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        targetPath: '/history',
        turnIndex: 0,
        turn: { role: 'user', msg: 'Which services contain dial functionality?' }
      }
    });

    await expect(
      runtime.execute({
        tool: 'completeTurn',
        requestId: 'tool-request-2',
        arguments: { targetPath: '/history', response: '4 services clearly contain dial functionality.' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        targetPath: '/history',
        responseField: 'msg',
        turn: { role: 'assistant', msg: '4 services clearly contain dial functionality.' }
      }
    });
    expect(getData()).toEqual({
      history: [
        { role: 'user', msg: 'Which services contain dial functionality?' },
        { role: 'assistant', msg: '4 services clearly contain dial functionality.' }
      ]
    });
  });

  it('can complete a specific user message index in role/message history arrays', async () => {
    const schema = {
      type: 'object',
      properties: {
        history: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'msg'],
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system'] },
              msg: { type: 'string' }
            }
          }
        }
      },
      required: ['history'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, {
      history: [
        { role: 'user', msg: 'First question?' },
        { role: 'user', msg: 'Second question?' }
      ]
    });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'completeTurn',
        requestId: 'tool-request-1',
        arguments: { targetPath: '/history', turnIndex: 0, response: 'First answer.' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        targetPath: '/history',
        turnIndex: 1,
        turn: { role: 'assistant', msg: 'First answer.' }
      }
    });
    expect(getData()).toEqual({
      history: [
        { role: 'user', msg: 'First question?' },
        { role: 'assistant', msg: 'First answer.' },
        { role: 'user', msg: 'Second question?' }
      ]
    });
  });

  it('rejects a turn that does not satisfy required schema fields without saving', async () => {
    const schema = {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' },
              source: { type: 'string' }
            },
            required: ['request', 'response', 'source'],
            additionalProperties: false
          }
        }
      },
      required: ['turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { turns: [] });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'valid-record' });

    await expect(
      runtime.execute({
        tool: 'startTurn',
        requestId: 'tool-request-1',
        arguments: { targetPath: '/turns', inquiry: 'What changed?', response: 'A turn tool was added.' }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: expect.stringContaining('Missing required field: source')
      }
    });
    expect(getData()).toEqual({ turns: [] });
  });

  it('creates a valid turn without being blocked by unrelated root validation issues', async () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        persona: { type: 'string', enum: ['TPM', 'developer', 'SME'] },
        turns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: { type: 'string' },
              response: { type: 'string' }
            },
            required: ['request', 'response'],
            additionalProperties: false
          }
        }
      },
      required: ['id', 'persona', 'turns'],
      additionalProperties: false
    };
    const { adapter, getData } = createRecordStorage(schema, { id: 'q101' });
    const runtime = createLocalToolRuntime({ storage: adapter, selectedProjectId: 'sample-project', selectedRecordId: 'q101' });

    await expect(
      runtime.execute({
        tool: 'startTurn',
        requestId: 'tool-request-1',
        arguments: { targetPath: '/turns', inquiry: '' }
      })
    ).resolves.toMatchObject({
      requestId: 'tool-request-1',
      ok: true,
      result: {
        targetPath: '/turns',
        turnIndex: 0,
        turn: { request: '', response: '' }
      }
    });
    expect(getData()).toEqual({ id: 'q101', turns: [{ request: '', response: '' }] });
  });
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
