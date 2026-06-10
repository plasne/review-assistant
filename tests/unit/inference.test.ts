// @vitest-environment node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInferenceAppEnvPath, resolveInferenceIterations } from '../../src/main/inference-cli';
import {
  caseArtifactPath,
  createInferenceAgent,
  DETERMINISTIC_SEARCH_TOOL,
  INFERENCE_PROMPT_TIMEOUT_MS,
  loadGroundTruthCases,
  manifestBlobPath,
  runInference,
  type GroundTruthCase,
  type InferenceAgent,
  type InferenceArtifactWriter
} from '../../src/main/inference';
import type { ChatContext, ChatStreamHandlers } from '../../src/main/agent';
import type { ChatStreamStartResult } from '../../src/shared/types';
import type { LocalToolRuntime } from '../../src/main/tools';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('inference ground truth loading', () => {
  it('loads only direct JSON ground truth files and reports parse errors as structured load errors', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'b.json'),
      `${JSON.stringify(createCase({ caseId: 'case-b' }), null, 2)}\n`
    );
    await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'a.json'), '{ invalid json');
    await fs.mkdir(path.join(repoRoot, 'ground-truth', '00', 'nested'));
    await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'nested', 'ignored.json'), '{}');

    await expect(loadGroundTruthCases(repoRoot)).resolves.toMatchObject({
      cases: [
        {
          groupId: '00',
          caseId: 'b'
        }
      ],
      loadErrors: [
        {
          caseId: 'a',
          error: { code: 'GROUND_TRUTH_PARSE_ERROR' }
        }
      ]
    });
  });
});

describe('inference CLI config', () => {
  it('uses ground-truth/config/.env', async () => {
    const repoRoot = await createTempRepo();

    expect(getInferenceAppEnvPath(repoRoot)).toBe(path.join(repoRoot, 'ground-truth', 'config', '.env'));
  });

  it('passes inference config values into the default agent environment and agent settings', () => {
    const agent = createInferenceAgent({
      AGENT_MODEL: 'gpt-5.4-mini',
      COPILOT_GITHUB_TOKEN: 'token',
      AZURE_STORAGE_ACCOUNT_NAME: 'account',
      REASONING_EFFORT: 'high'
    });
    const options = Reflect.get(agent, 'options') as { agentSettings?: unknown; commandEnv?: Record<string, string> };

    expect(options.commandEnv).toEqual({
      AGENT_MODEL: 'gpt-5.4-mini',
      COPILOT_GITHUB_TOKEN: 'token',
      AZURE_STORAGE_ACCOUNT_NAME: 'account',
      REASONING_EFFORT: 'high'
    });
    expect(options.agentSettings).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: 'high' });
  });

  it('reads iterations from inference config values when no shell override is set', () => {
    expect(resolveInferenceIterations({ ITERATIONS: '10' }, {})).toBe(10);
  });

  it('lets shell iterations override inference config values', () => {
    expect(resolveInferenceIterations({ ITERATIONS: '10' }, { ITERATIONS: '3' })).toBe(3);
  });

  it('rejects invalid configured iteration counts', () => {
    expect(() => resolveInferenceIterations({ ITERATIONS: '0' }, {})).toThrow('ITERATIONS must be a positive integer.');
  });
});

describe('inference run artifacts', () => {
  it('uses a per-prompt timeout by default', () => {
    expect(INFERENCE_PROMPT_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });

  it('runs every loaded case through staged local project storage and uploads case artifacts plus a manifest', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'config', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['server.js'], env: { TOKEN: '${TEST_TOKEN}' } } } }, null, 2)}\n`
    );
    const sourceCasePath = path.join(repoRoot, 'ground-truth', '00', 'case-a.json');
    await fs.writeFile(
      sourceCasePath,
      `${JSON.stringify(
        createCase({
          caseId: 'case-a',
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] }
        }),
        null,
        2
      )}\n`
    );
    const writer = new MemoryArtifactWriter();
    const agent = new FixtureSavingAgent();

    const result = await runInference({
      repoRoot,
      runFolder: '1700000000000',
      iterations: 3,
      appConfigValues: { TEST_TOKEN: 'abc123' },
      artifactWriter: writer,
      agent
    });

    expect(agent.contexts).toHaveLength(3);
    expect(agent.contexts[0]).toEqual(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Use grouped inference settings.'),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: DETERMINISTIC_SEARCH_TOOL, source: 'plugin' }),
          expect.objectContaining({ name: 'readRecord', source: 'built-in' })
        ]),
        mcpServers: [expect.objectContaining({ id: 'fixture', command: 'node', env: { TOKEN: 'abc123' } })]
      })
    );
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0]).toEqual(
      expect.objectContaining({
        caseId: 'case-a',
        ref: 'ref-a',
        iteration: '0',
        status: 'completed',
        ground_truth: expect.objectContaining({
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] },
          schema: testSchema
        }),
        output: {
          question: 'What is supported?',
          evidence: expect.arrayContaining([
            expect.objectContaining({
              title: 'Evidence workflow',
              url: 'https://example.com/review-assistant/evidence'
            })
          ])
        },
        transcript: expect.arrayContaining([
          expect.objectContaining({ type: 'user-prompt', success: true, content: 'Find supporting evidence.' }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: DETERMINISTIC_SEARCH_TOOL }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: 'saveSearchResults' }),
          expect.objectContaining({ type: 'assistant-response', success: true, content: 'Saved evidence.' })
        ])
      })
    );
    expect(writer.uploads[0].value).toEqual({
      ground_truth: expect.objectContaining({
        input: { question: 'What is supported?', evidence: [] },
        output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] },
        schema: testSchema
      }),
      inference: expect.objectContaining({
        ref: 'ref-a',
        iteration: '0',
        run_folder: '1700000000000',
        case_id: 'case-a',
        model: 'gpt-5.4-mini',
        status: 'completed',
        output: {
          question: 'What is supported?',
          evidence: expect.arrayContaining([
            expect.objectContaining({
              title: 'Evidence workflow',
              url: 'https://example.com/review-assistant/evidence'
            })
          ])
        },
        transcript: [
          expect.objectContaining({ type: 'user-prompt', elapsed_ms: 0, success: true, content: 'Find supporting evidence.' }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: DETERMINISTIC_SEARCH_TOOL }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: 'saveSearchResults' }),
          expect.objectContaining({ type: 'assistant-response', success: true, content: 'Saved evidence.' })
        ]
      })
    });
    const writtenInference = (writer.uploads[0].value as { inference: Record<string, unknown> }).inference;
    expect(writtenInference).not.toHaveProperty('promptTranscript');
    expect(writtenInference).not.toHaveProperty('assistantTranscript');
    expect(writtenInference).not.toHaveProperty('toolCalls');
    expect(writtenInference).not.toHaveProperty('events');
    expect(writtenInference).not.toHaveProperty('metrics');
    expect(writtenInference).not.toHaveProperty('runFolder');
    expect(writtenInference).not.toHaveProperty('caseId');
    expect(writtenInference).not.toHaveProperty('startedAt');
    expect(writtenInference).not.toHaveProperty('elapsedMs');
    const writtenTranscript = writtenInference.transcript as Array<{ type: string; started_at: string }>;
    expect(writtenTranscript.map((entry) => entry.started_at)).toEqual(
      [...writtenTranscript].map((entry) => entry.started_at).sort((left, right) => left.localeCompare(right))
    );
    const writtenAssistantResponse = writtenTranscript.find((entry) => entry.type === 'assistant-response');
    expect(writtenAssistantResponse).toEqual(
      expect.objectContaining({
        elapsed_ms: expect.any(Number),
        metadata: {
          assistantRequestElapsedMs: expect.any(Number),
          firstTokenLatencyMs: expect.any(Number),
          streamElapsedMs: expect.any(Number)
        }
      })
    );
    expect(writtenTranscript[0]).not.toHaveProperty('startedAt');
    expect(writtenTranscript[0]).not.toHaveProperty('elapsedMs');
    expect(Object.keys(writer.uploads[0].value as Record<string, unknown>)).toEqual(['ground_truth', 'inference']);
    expect(result.manifest).toMatchObject({
      runFolder: '1700000000000',
      iterations: 3,
      groundTruth: {
        refs: ['ref-a']
      },
      counts: { completed: 3, failed: 0, timeout: 0 },
      artifactBlobPaths: ['1700000000000/ref-a-0.json', '1700000000000/ref-a-1.json', '1700000000000/ref-a-2.json']
    });
    expect(writer.uploads.map((upload) => upload.path)).toEqual([
      '1700000000000/ref-a-0.json',
      '1700000000000/ref-a-1.json',
      '1700000000000/ref-a-2.json',
      '1700000000000/manifest.json'
    ]);
    await expect(fs.readFile(sourceCasePath, 'utf8').then((content) => JSON.parse(content))).resolves.toMatchObject({
      input: { question: 'What is supported?', evidence: [] },
      prompts: ['Find supporting evidence.']
    });
  });

  it('does not fail a completed case when the agent inspects the root schema as slash after updating output', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'case-a.json'),
      `${JSON.stringify(
        createCase({
          caseId: 'case-a',
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] }
        }),
        null,
        2
      )}\n`
    );
    const writer = new MemoryArtifactWriter();

    const result = await runInference({
      repoRoot,
      runFolder: '1700000000000',
      iterations: 1,
      appConfigValues: {},
      artifactWriter: writer,
      agent: new RootSchemaAfterSaveAgent()
    });

    expect(result.cases[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        output: expect.objectContaining({
          evidence: expect.arrayContaining([expect.objectContaining({ title: 'Evidence workflow' })])
        }),
        transcript: expect.arrayContaining([
          expect.objectContaining({ type: 'tool-call', success: true, tool: 'saveSearchResults' }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: 'getRecordSchema' }),
          expect.objectContaining({ type: 'assistant-response', success: true, content: 'Saved evidence and inspected schema.' })
        ])
      })
    );
    expect(result.cases[0]).not.toHaveProperty('error');
    expect(result.manifest.counts).toEqual({ completed: 1, failed: 0, timeout: 0 });
    expect((writer.uploads[0].value as { inference: { status: string; error?: unknown } }).inference).toMatchObject({ status: 'completed' });
    expect((writer.uploads[0].value as { inference: { error?: unknown } }).inference.error).toBeUndefined();
  });

  it('keeps recovered tool failures in the transcript without failing completed inference output', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'case-a.json'),
      `${JSON.stringify(
        createCase({
          caseId: 'case-a',
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] }
        }),
        null,
        2
      )}\n`
    );
    const writer = new MemoryArtifactWriter();

    const result = await runInference({
      repoRoot,
      runFolder: '1700000000000',
      iterations: 1,
      appConfigValues: {},
      artifactWriter: writer,
      agent: new RecoveredToolFailureAgent()
    });

    expect(result.cases[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        output: expect.objectContaining({
          evidence: expect.arrayContaining([expect.objectContaining({ title: 'Evidence workflow' })])
        }),
        transcript: expect.arrayContaining([
          expect.objectContaining({ type: 'tool-call', success: false, tool: 'getRecordSchema', error: { code: 'INVALID_TOOL_ARGUMENTS', message: 'No schema exists at /missing.' } }),
          expect.objectContaining({ type: 'tool-call', success: true, tool: 'saveSearchResults' }),
          expect.objectContaining({ type: 'assistant-response', success: true, content: 'Recovered and saved evidence.' })
        ])
      })
    );
    expect(result.cases[0]).not.toHaveProperty('error');
    expect(result.manifest.counts).toEqual({ completed: 1, failed: 0, timeout: 0 });
  });

  it('writes a structured timeout artifact with the staged record output when a prompt times out', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'case-a.json'),
      `${JSON.stringify(
        createCase({
          caseId: 'case-a',
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] }
        }),
        null,
        2
      )}\n`
    );
    const writer = new MemoryArtifactWriter();
    const agent = new NeverCompletingAgent();

    const result = await runInference({
      repoRoot,
      runFolder: '1700000000000',
      iterations: 1,
      artifactWriter: writer,
      agent,
      promptTimeoutMs: 1
    });

    expect(agent.canceledRequestIds).toEqual(['request-1']);
    expect(result.cases[0]).toEqual(
      expect.objectContaining({
        status: 'timeout',
        error: { code: 'INFERENCE_TIMEOUT', message: 'Inference prompt timed out.' },
        output: { question: 'What is supported?', evidence: [] },
        transcript: expect.arrayContaining([
          expect.objectContaining({ type: 'user-prompt', success: true, content: 'Find supporting evidence.' }),
          expect.objectContaining({
            type: 'event',
            success: false,
            metadata: { event: 'error' },
            error: { code: 'INFERENCE_TIMEOUT', message: 'Inference prompt timed out.' }
          })
        ])
      })
    );
    expect(result.manifest.counts).toEqual({ completed: 0, failed: 0, timeout: 1 });
    expect((writer.uploads[0].value as { inference: { status: string; output: unknown } }).inference).toMatchObject({
      status: 'timeout',
      output: { question: 'What is supported?', evidence: [] }
    });
  });

  it('returns a tool error and restores the staged output record when a tool writes malformed JSON', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, 'ground-truth', 'config', 'corrupt-plugin.mjs'), corruptPluginSource);
    await fs.writeFile(
      path.join(repoRoot, 'ground-truth', '00', 'case-a.json'),
      `${JSON.stringify(
        createCase({
          caseId: 'case-a',
          input: { question: 'What is supported?', evidence: [] },
          output: { question: 'What is supported?', evidence: [{ title: 'Doc', url: 'https://example.com' }] }
        }),
        null,
        2
      )}\n`
    );
    const writer = new MemoryArtifactWriter();

    const result = await runInference({
      repoRoot,
      runFolder: '1700000000000',
      iterations: 1,
      artifactWriter: writer,
      agent: new CorruptingAgent()
    });

    expect(result.cases[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          code: 'INFERENCE_CASE_FAILED',
          message: expect.stringContaining('left selected record JSON invalid; reverted record to pre-tool state')
        }),
        output: { question: 'What is supported?', evidence: [] },
        transcript: expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-call',
            success: false,
            tool: 'corruptRecord',
            error: expect.objectContaining({
              code: 'PROVIDER_ERROR',
              message: expect.stringContaining('left selected record JSON invalid; reverted record to pre-tool state')
            })
          }),
          expect.objectContaining({
            type: 'event',
            success: false,
            error: expect.objectContaining({ code: 'INFERENCE_CASE_FAILED' })
          })
        ])
      })
    );
    expect(result.manifest.counts).toEqual({ completed: 0, failed: 1, timeout: 0 });
    expect((writer.uploads[0].value as { inference: { model?: string; status: string; output: unknown; error?: unknown } }).inference).toMatchObject({
      status: 'failed',
      output: { question: 'What is supported?', evidence: [] },
      error: expect.objectContaining({ code: 'INFERENCE_CASE_FAILED' })
    });
  });

  it('keeps path organization stable and rejects unsafe blob path segments', () => {
    expect(caseArtifactPath('1700000000000', 'ref-1', '2')).toBe('1700000000000/ref-1-2.json');
    expect(manifestBlobPath('1700000000000')).toBe('1700000000000/manifest.json');
    expect(() => caseArtifactPath('../run', 'ref-1', '1')).toThrow('Invalid inference blob path segment');
  });

  it('rejects duplicate case refs before uploading artifacts', async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'case-a.json'), `${JSON.stringify(createCase({ caseId: 'case-a', ref: 'same-ref' }), null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'case-b.json'), `${JSON.stringify(createCase({ caseId: 'case-b', ref: 'same-ref' }), null, 2)}\n`);
    const writer = new MemoryArtifactWriter();

    await expect(
      runInference({
        repoRoot,
        runFolder: '1700000000000',
        iterations: 1,
        artifactWriter: writer,
        agent: new FixtureSavingAgent()
      })
    ).rejects.toThrow('Duplicate ground truth ref: same-ref');
    expect(writer.uploads).toEqual([]);
  });
});

const createTempRepo = async (): Promise<string> => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-inference-test-'));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, 'ground-truth', '00', 'config'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'ground-truth', 'config'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'ground-truth', 'config', 'search-plugin.mjs'), searchPluginSource);
  await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'config', 'schema.json'), `${JSON.stringify(testSchema, null, 2)}\n`);
  await fs.writeFile(path.join(repoRoot, 'ground-truth', '00', 'config', 'prompt.md'), 'Use grouped inference settings.\n');
  return repoRoot;
};

const searchPluginSource = `
const documents = [
  {
    title: 'Evidence workflow',
    url: 'https://example.com/review-assistant/evidence',
    content: 'Search results should be saved as evidence entries with titles and URLs.'
  },
  {
    title: 'Schema guidance',
    url: 'https://example.com/review-assistant/schema',
    content: 'Inspect schemas before writing generated data.'
  }
];

const scoreDocument = (document, terms) => {
  const haystack = \`\${document.title} \${document.content}\`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
};

export default {
  id: 'ground-truth-search',
  tools: [
    {
      name: 'searchKnowledgeBase',
      description: 'Search the indexed knowledge base for source passages and structured references relevant to the user request.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query.' },
          topK: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of ranked results to return.' }
        },
        required: ['query'],
        additionalProperties: false
      },
      execute: async (request) => {
        const terms = String(request.arguments.query ?? '').toLowerCase().split(/\\W+/).filter(Boolean);
        const results = documents
          .map((document) => ({ document, score: scoreDocument(document, terms) }))
          .sort((left, right) => right.score - left.score)
          .slice(0, request.arguments.topK ?? 3)
          .map(({ document }) => ({ title: document.title, url: document.url }));
        return { requestId: request.requestId, ok: true, result: { query: request.arguments.query, results } };
      }
    }
  ]
};
`;

const corruptPluginSource = `
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'corrupt-record',
  tools: [
    {
      name: 'corruptRecord',
      description: 'Test-only tool that corrupts the selected record JSON file.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute: async (request, context) => {
        const root = context.storage.config.values.LOCAL_PATH;
        await fs.appendFile(path.join(root, context.selectedProjectId, \`\${context.selectedRecordId}.json\`), '\\n  "dangling": true\\n}');
        return { requestId: request.requestId, ok: true, result: { corrupted: true } };
      }
    }
  ]
};
`;

type GroundTruthCaseJson = Omit<GroundTruthCase, 'groupId' | 'groundTruth'>;

const createCase = (overrides: Partial<GroundTruthCaseJson> = {}): GroundTruthCaseJson => ({
  ref: 'ref-a',
  caseId: 'case-a',
  description: 'Case A',
  input: { question: 'What is supported?', evidence: [] },
  prompts: ['Find supporting evidence.'],
  output: { question: 'What is supported?', evidence: [] },
  ...overrides
});

const testSchema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' }
        },
        required: ['title', 'url'],
        additionalProperties: false
      }
    }
  },
  required: ['question', 'evidence'],
  additionalProperties: false
};

class MemoryArtifactWriter implements InferenceArtifactWriter {
  readonly uploads: Array<{ path: string; value: unknown }> = [];

  async uploadJson(blobPath: string, value: unknown): Promise<void> {
    this.uploads.push({ path: blobPath, value });
  }
}

class FixtureSavingAgent implements InferenceAgent {
  readonly contexts: ChatContext[] = [];

  async start(context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    this.contexts.push(context);
    queueMicrotask(async () => {
      try {
        const search = await tools.execute({
          tool: DETERMINISTIC_SEARCH_TOOL,
          requestId: 'search-1',
          arguments: { query: 'supporting evidence' }
        });
        if (!search.ok || !isRecord(search.result) || !Array.isArray(search.result.results)) {
          throw new Error(search.ok ? 'Invalid search fixture.' : search.error.message);
        }
        const save = await tools.execute({
          tool: 'saveSearchResults',
          requestId: 'save-1',
          arguments: { containerPath: '/evidence', mode: 'replace', results: search.result.results }
        });
        if (!save.ok) {
          throw new Error(save.error.message);
        }
        handlers.chunk({ requestId: 'request-1', messageId: 'message-1', content: 'Saved evidence.' });
        handlers.log?.({
          level: 'info',
          event: 'review-assistant.agent-provider-usage',
          fields: { requestId: 'request-1', model: 'gpt-5.4-mini', reasoningEffort: 'medium' }
        });
        handlers.complete({ requestId: 'request-1', messageId: 'message-1' });
      } catch (error) {
        handlers.error({
          requestId: 'request-1',
          messageId: 'message-1',
          error: {
            code: 'PROVIDER_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        });
      }
    });
    return { requestId: 'request-1', messageId: 'message-1' };
  }

  cancel(): boolean {
    return true;
  }
}

class RootSchemaAfterSaveAgent implements InferenceAgent {
  async start(_context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    queueMicrotask(async () => {
      try {
        const search = await tools.execute({
          tool: DETERMINISTIC_SEARCH_TOOL,
          requestId: 'search-1',
          arguments: { query: 'supporting evidence' }
        });
        if (!search.ok || !isRecord(search.result) || !Array.isArray(search.result.results)) {
          throw new Error(search.ok ? 'Invalid search fixture.' : search.error.message);
        }
        const save = await tools.execute({
          tool: 'saveSearchResults',
          requestId: 'save-1',
          arguments: { containerPath: '/evidence', mode: 'replace', results: search.result.results }
        });
        if (!save.ok) {
          throw new Error(save.error.message);
        }
        const schema = await tools.execute({
          tool: 'getRecordSchema',
          requestId: 'schema-1',
          arguments: { targetPath: '/' }
        });
        if (!schema.ok) {
          throw new Error(schema.error.message);
        }
        handlers.chunk({ requestId: 'request-1', messageId: 'message-1', content: 'Saved evidence and inspected schema.' });
        handlers.complete({ requestId: 'request-1', messageId: 'message-1' });
      } catch (error) {
        handlers.error({
          requestId: 'request-1',
          messageId: 'message-1',
          error: {
            code: 'PROVIDER_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        });
      }
    });
    return { requestId: 'request-1', messageId: 'message-1' };
  }

  cancel(): boolean {
    return true;
  }
}

class RecoveredToolFailureAgent implements InferenceAgent {
  async start(_context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    queueMicrotask(async () => {
      try {
        await tools.execute({
          tool: 'getRecordSchema',
          requestId: 'schema-1',
          arguments: { targetPath: '/missing' }
        });
        const search = await tools.execute({
          tool: DETERMINISTIC_SEARCH_TOOL,
          requestId: 'search-1',
          arguments: { query: 'supporting evidence' }
        });
        if (!search.ok || !isRecord(search.result) || !Array.isArray(search.result.results)) {
          throw new Error(search.ok ? 'Invalid search fixture.' : search.error.message);
        }
        const save = await tools.execute({
          tool: 'saveSearchResults',
          requestId: 'save-1',
          arguments: { containerPath: '/evidence', mode: 'replace', results: search.result.results }
        });
        if (!save.ok) {
          throw new Error(save.error.message);
        }
        handlers.chunk({ requestId: 'request-1', messageId: 'message-1', content: 'Recovered and saved evidence.' });
        handlers.complete({ requestId: 'request-1', messageId: 'message-1' });
      } catch (error) {
        handlers.error({
          requestId: 'request-1',
          messageId: 'message-1',
          error: {
            code: 'PROVIDER_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        });
      }
    });
    return { requestId: 'request-1', messageId: 'message-1' };
  }

  cancel(): boolean {
    return true;
  }
}

class NeverCompletingAgent implements InferenceAgent {
  readonly canceledRequestIds: string[] = [];

  async start(): Promise<ChatStreamStartResult> {
    return { requestId: 'request-1', messageId: 'message-1' };
  }

  cancel(requestId: string): boolean {
    this.canceledRequestIds.push(requestId);
    return true;
  }
}

class CorruptingAgent implements InferenceAgent {
  async start(_context: ChatContext, handlers: ChatStreamHandlers, tools: LocalToolRuntime): Promise<ChatStreamStartResult> {
    queueMicrotask(async () => {
      try {
        const corrupt = await tools.execute({
          tool: 'corruptRecord',
          requestId: 'corrupt-1',
          arguments: {}
        });
        if (!corrupt.ok) {
          throw new Error(corrupt.error.message);
        }
        handlers.log?.({
          level: 'info',
          event: 'review-assistant.agent-provider-usage',
          fields: { requestId: 'request-1', model: 'gpt-5.4-mini', reasoningEffort: 'medium' }
        });
        handlers.chunk({ requestId: 'request-1', messageId: 'message-1', content: 'Corrupted record.' });
        handlers.complete({ requestId: 'request-1', messageId: 'message-1' });
      } catch (error) {
        handlers.error({
          requestId: 'request-1',
          messageId: 'message-1',
          error: {
            code: 'PROVIDER_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        });
      }
    });
    return { requestId: 'request-1', messageId: 'message-1' };
  }

  cancel(): boolean {
    return true;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
