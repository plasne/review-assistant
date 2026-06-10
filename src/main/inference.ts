import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { parseAgentSettingsFromEnvValues } from '../shared/agent-settings';
import type {
  AppConfig,
  ChatMessage,
  ExternalMcpServerConfig,
  ToolInvocationRequest,
  ToolInvocationResponse
} from '../shared/types';
import { logError, logInfo } from '../shared/logging';
import { AgentRuntime } from './agent';
import { parseExternalMcpServers } from './mcp';
import { LocalStorageAdapter } from './storage';
import { createLocalToolRuntime, discoverLocalToolPlugins, type LocalToolPlugin, type LocalToolRuntime } from './tools';

export const INFERENCE_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;
export const DETERMINISTIC_SEARCH_TOOL = 'searchKnowledgeBase';

export type GroundTruthCase = {
  projectId: string;
  ref: string;
  caseId: string;
  description: string;
  input: unknown;
  prompts: string[];
  output: unknown;
  tags?: string[];
  groundTruth: Record<string, unknown>;
};

export type GroundTruthLoadError = {
  fileName: string;
  caseId: string;
  error: InferenceErrorPayload;
};

export type GroundTruthLoadResult = {
  cases: GroundTruthCase[];
  loadErrors: GroundTruthLoadError[];
};

export type InferenceStatus = 'completed' | 'failed' | 'timeout';

export type InferenceErrorPayload = {
  code: string;
  message: string;
};

export type InferenceToolCall = {
  tool: string;
  input: Record<string, unknown>;
  fixtureOutput?: unknown;
  result?: unknown;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  error?: InferenceErrorPayload;
};

export type InferenceTranscriptEntry = {
  type: 'user-prompt' | 'assistant-response' | 'tool-call' | 'event';
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  success: boolean;
  metadata?: Record<string, unknown>;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: InferenceErrorPayload;
};

export type WrittenInferenceJson = {
  ground_truth: unknown;
  inference: WrittenInferenceCaseDetails;
};

export type WrittenInferenceTranscriptEntry = {
  type: InferenceTranscriptEntry['type'];
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  success: boolean;
  metadata?: Record<string, unknown>;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: InferenceErrorPayload;
};

export type WrittenInferenceCaseDetails = {
  ref: string;
  iteration: string;
  run_folder: string;
  case_id: string;
  model?: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  output: unknown;
  transcript: WrittenInferenceTranscriptEntry[];
  status: InferenceStatus;
  error?: InferenceErrorPayload;
};

export type InferenceCaseArtifact = {
  ref: string;
  iteration: string;
  runFolder: string;
  caseId: string;
  model?: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  ground_truth: unknown;
  output: unknown;
  transcript: InferenceTranscriptEntry[];
  status: InferenceStatus;
  error?: InferenceErrorPayload;
};

export type InferenceManifest = {
  runFolder: string;
  iterations: number;
  groundTruth: {
    root: string;
    caseCount: number;
    refs: string[];
  };
  counts: Record<InferenceStatus, number>;
  totalElapsedMs: number;
  avgCaseElapsedMs: number;
  artifactBlobPaths: string[];
};

export type InferenceRunResult = {
  manifest: InferenceManifest;
  cases: InferenceCaseArtifact[];
};

export type InferenceArtifactWriter = {
  uploadJson: (blobPath: string, value: unknown) => Promise<void>;
};

export type InferenceAgent = {
  start: AgentRuntime['start'];
  cancel: AgentRuntime['cancel'];
};

export const createInferenceAgent = (appConfigValues: Record<string, string> | undefined): InferenceAgent =>
  new AgentRuntime({
    workerPath: path.join(__dirname, '../agent/agent-process.js'),
    commandEnv: appConfigValues,
    agentSettings: parseAgentSettingsFromEnvValues(appConfigValues ?? {})
  });

export type RunInferenceOptions = {
  repoRoot: string;
  runFolder: string;
  iterations: number;
  appConfigValues?: Record<string, string>;
  promptTimeoutMs?: number;
  agent?: InferenceAgent;
  artifactWriter: InferenceArtifactWriter;
};

type ToolCallRecorder = {
  calls: InferenceToolCall[];
  transcript: InferenceTranscriptEntry[];
};

export type AzureInferenceArtifactWriterOptions = {
  containerName: string;
};

export const loadGroundTruthCases = async (repoRoot: string): Promise<GroundTruthLoadResult> => {
  const root = path.join(repoRoot, 'ground-truth');
  const storage = createGroundTruthStorage(root);
  const projects = await storage.listProjects();
  const cases: GroundTruthCase[] = [];
  const loadErrors: GroundTruthLoadError[] = [];

  for (const project of projects) {
    const projectId = project.id;
    const projectRoot = path.join(root, projectId);
    let records: Array<{ id: string }>;
    let schema: unknown;
    try {
      const openedProject = await storage.openProject(projectId);
      records = openedProject.records;
      schema = openedProject.schema;
    } catch (error) {
      loadErrors.push({
        fileName: `${projectId}/config`,
        caseId: projectId,
        error: {
          code: 'GROUND_TRUTH_CONFIG_ERROR',
          message: error instanceof Error ? error.message : String(error)
        }
      });
      continue;
    }
    for (const record of records) {
      const fileName = `${record.id}.json`;
      const relativeName = `${projectId}/${fileName}`;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, fileName), 'utf8')) as Omit<
          GroundTruthCase,
          'projectId' | 'groundTruth'
        >;
        cases.push({
          ...parsed,
          groundTruth: { ...cloneJson(parsed), schema: cloneJson(schema) },
          projectId,
          caseId: record.id
        });
      } catch (error) {
        loadErrors.push({
          fileName: relativeName,
          caseId: path.basename(fileName, '.json'),
          error: {
            code: 'GROUND_TRUTH_PARSE_ERROR',
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }
  return { cases, loadErrors };
};

const createGroundTruthStorage = (localPath: string): LocalStorageAdapter =>
  new LocalStorageAdapter({
    backendKind: 'local',
    values: { LOCAL_PATH: localPath },
    appEnvPath: path.join(localPath, 'config', '.env')
  });

export const runInference = async (options: RunInferenceOptions): Promise<InferenceRunResult> => {
  const startedAt = Date.now();
  const groundTruthRoot = path.join(options.repoRoot, 'ground-truth');
  const promptTimeoutMs = options.promptTimeoutMs ?? INFERENCE_PROMPT_TIMEOUT_MS;
  const { cases, loadErrors } = await loadGroundTruthCases(options.repoRoot);
  assertUniqueCaseRefs(cases);
  const localToolPlugins = await loadGroundTruthLocalToolPlugins(options.repoRoot);
  const agent = options.agent ?? createInferenceAgent(options.appConfigValues);
  const artifacts: InferenceCaseArtifact[] = [];
  const artifactBlobPaths: string[] = [];

  logInfo('review-assistant.inference-run-started', {
    runFolder: options.runFolder,
    iterations: options.iterations,
    caseCount: cases.length,
    loadErrorCount: loadErrors.length,
    promptTimeoutMs
  });

  for (let iterationIndex = 0; iterationIndex < options.iterations; iterationIndex += 1) {
    const iteration = String(iterationIndex);
    for (const loadError of loadErrors) {
      const artifact = createFailedCaseArtifact(options, iteration, loadError.caseId, loadError.caseId, loadError.error, groundTruthRoot, 'failed');
      const blobPath = caseArtifactPath(options.runFolder, artifact.ref, artifact.iteration);
      await options.artifactWriter.uploadJson(blobPath, toWrittenInferenceJson(artifact));
      artifacts.push(artifact);
      artifactBlobPaths.push(blobPath);
    }
    for (const groundTruthCase of cases) {
      const artifact = await runCase(options, agent, localToolPlugins, groundTruthCase, iteration, promptTimeoutMs);
      const blobPath = caseArtifactPath(options.runFolder, artifact.ref, artifact.iteration);
      await options.artifactWriter.uploadJson(blobPath, toWrittenInferenceJson(artifact));
      artifacts.push(artifact);
      artifactBlobPaths.push(blobPath);
    }
  }

  const totalElapsedMs = Date.now() - startedAt;
  const manifest: InferenceManifest = {
    runFolder: options.runFolder,
    iterations: options.iterations,
    groundTruth: {
      root: groundTruthRoot,
      caseCount: cases.length + loadErrors.length,
      refs: cases.map((groundTruthCase) => groundTruthCase.ref)
    },
    counts: countStatuses(artifacts),
    totalElapsedMs,
    avgCaseElapsedMs: artifacts.length === 0 ? 0 : Math.round(artifacts.reduce((total, artifact) => total + artifact.elapsedMs, 0) / artifacts.length),
    artifactBlobPaths
  };
  const manifestPath = manifestBlobPath(options.runFolder);
  await options.artifactWriter.uploadJson(manifestPath, manifest);
  logInfo('review-assistant.inference-run-completed', {
    runFolder: options.runFolder,
    iterations: options.iterations,
    completed: manifest.counts.completed,
    failed: manifest.counts.failed,
    timeout: manifest.counts.timeout,
    elapsedMs: totalElapsedMs
  });
  return { manifest, cases: artifacts };
};

export class AzureInferenceArtifactWriter implements InferenceArtifactWriter {
  private readonly client: BlobServiceClient;

  constructor(
    config: AppConfig,
    private readonly options: AzureInferenceArtifactWriterOptions
  ) {
    if (config.backendKind === 'azure-connection-string') {
      this.client = BlobServiceClient.fromConnectionString(config.values.AZURE_STORAGE_ACCOUNT_CONNSTRING);
    } else if (config.backendKind === 'azure-default-credential') {
      const accountName = config.values.AZURE_STORAGE_ACCOUNT_NAME;
      if (!accountName) {
        throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required for inference output.');
      }
      this.client = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new DefaultAzureCredential());
    } else {
      throw new Error('Inference output requires Azure Blob Storage configuration.');
    }
    if (!options.containerName.trim()) {
      throw new Error('INFERENCE_CONTAINER is required for inference output.');
    }
  }

  async uploadJson(blobPath: string, value: unknown): Promise<void> {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const container = this.client.getContainerClient(this.options.containerName);
    await container.createIfNotExists();
    await container.getBlockBlobClient(blobPath).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' }
    });
  }
}

const runCase = async (
  options: RunInferenceOptions,
  agent: InferenceAgent,
  localToolPlugins: LocalToolPlugin[],
  groundTruthCase: GroundTruthCase,
  iteration: string,
  promptTimeoutMs: number
): Promise<InferenceCaseArtifact> => {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const transcript: InferenceTranscriptEntry[] = [];
  const recorder: ToolCallRecorder = { calls: [], transcript };
  const staged = await stageGroundTruthCase(options.repoRoot, groundTruthCase);
  let projectPrompt: string | undefined;
  let mcpServers: ExternalMcpServerConfig[] = [];
  let tools: LocalToolRuntime | undefined;
  const history: ChatMessage[] = [];
  let model: string | undefined;
  let status: InferenceStatus = 'completed';
  let error: InferenceErrorPayload | undefined;
  let output: unknown;

  logInfo('review-assistant.inference-case-started', {
    ref: groundTruthCase.ref,
    iteration,
    runFolder: options.runFolder,
    caseId: groundTruthCase.caseId,
    promptCount: groundTruthCase.prompts.length
  });

  try {
    const projectConfig = await staged.storage.getProjectConfig(groundTruthCase.projectId);
    projectPrompt = await staged.storage.getProjectPrompt(groundTruthCase.projectId);
    const projectMcpConfig = await staged.storage.getProjectMcpConfig(groundTruthCase.projectId);
    mcpServers = parseExternalMcpServers(projectMcpConfig, { ...(options.appConfigValues ?? {}), ...projectConfig });
    tools = createRecordingToolRuntime(
      createLocalToolRuntime({ storage: staged.storage, selectedProjectId: groundTruthCase.projectId, selectedRecordId: groundTruthCase.caseId }, localToolPlugins),
      recorder
    );
    for (const prompt of groundTruthCase.prompts) {
      const promptAt = new Date().toISOString();
      transcript.push({
        type: 'user-prompt',
        startedAt: promptAt,
        finishedAt: promptAt,
        elapsedMs: 0,
        success: true,
        content: prompt
      });
      const response = await runPrompt(agent, tools, groundTruthCase, prompt, history, projectPrompt, mcpServers, promptTimeoutMs);
      model = response.model ?? model;
      transcript.push({
        type: 'assistant-response',
        startedAt: response.startedAt,
        finishedAt: response.finishedAt,
        elapsedMs: response.elapsedMs,
        success: true,
        metadata: {
          assistantRequestElapsedMs: response.assistantRequestElapsedMs,
          firstTokenLatencyMs: response.firstTokenLatencyMs,
          streamElapsedMs: response.streamElapsedMs
        },
        content: response.content
      });
      const now = new Date().toISOString();
      history.push({ id: randomUUID(), role: 'user', content: prompt, createdAt: now });
      history.push({ id: randomUUID(), role: 'assistant', content: response.content || '[no streamed response]', createdAt: now });
    }
  } catch (caseError) {
    ({ status, error } = recordCaseError(caseError, transcript, 'INFERENCE_CASE_FAILED'));
  }

  try {
    output = await staged.storage.readRecordData(groundTruthCase.projectId, groundTruthCase.caseId);
  } catch (outputError) {
    output = {};
    if (!error) {
      ({ status, error } = recordCaseError(outputError, transcript, 'INFERENCE_OUTPUT_READ_FAILED'));
    } else {
      appendErrorEvent(transcript, {
        code: 'INFERENCE_OUTPUT_READ_FAILED',
        message: outputError instanceof Error ? outputError.message : String(outputError)
      });
    }
  }

  const finished = Date.now();
  const sortedTranscript = sortTranscript(transcript);
  const artifact: InferenceCaseArtifact = {
    ref: groundTruthCase.ref,
    iteration,
    runFolder: options.runFolder,
    caseId: groundTruthCase.caseId,
    model,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    elapsedMs: finished - started,
    ground_truth: cloneJson(groundTruthCase.groundTruth),
    output,
    transcript: sortedTranscript,
    status,
    ...(error ? { error } : {})
  };
  if (error) {
    logError('review-assistant.inference-case-failed', {
      ref: groundTruthCase.ref,
      iteration,
      runFolder: options.runFolder,
      caseId: groundTruthCase.caseId,
      code: error.code,
      elapsedMs: artifact.elapsedMs
    });
  }
  logInfo('review-assistant.inference-case-completed', {
    ref: groundTruthCase.ref,
    iteration,
    runFolder: options.runFolder,
    caseId: groundTruthCase.caseId,
    status,
    elapsedMs: artifact.elapsedMs,
    toolCallCount: artifact.transcript.filter((entry) => entry.type === 'tool-call').length
  });
  await staged.cleanup();
  return artifact;
};

const recordCaseError = (
  caseError: unknown,
  transcript: InferenceTranscriptEntry[],
  defaultCode: 'INFERENCE_CASE_FAILED' | 'INFERENCE_OUTPUT_READ_FAILED'
): { status: InferenceStatus; error: InferenceErrorPayload } => {
  const message = caseError instanceof Error ? caseError.message : String(caseError);
  const status: InferenceStatus = message.includes('timed out') || message.includes('canceled') ? 'timeout' : 'failed';
  const error: InferenceErrorPayload = {
    code: status === 'timeout' ? 'INFERENCE_TIMEOUT' : defaultCode,
    message
  };
  appendErrorEvent(transcript, error);
  return { status, error };
};

const appendErrorEvent = (transcript: InferenceTranscriptEntry[], error: InferenceErrorPayload): void => {
  const eventAt = new Date().toISOString();
  transcript.push({
    type: 'event',
    startedAt: eventAt,
    finishedAt: eventAt,
    elapsedMs: 0,
    success: false,
    metadata: { event: 'error' },
    error
  });
};

const runPrompt = async (
  agent: InferenceAgent,
  tools: LocalToolRuntime,
  groundTruthCase: GroundTruthCase,
  prompt: string,
  history: ChatMessage[],
  systemPrompt: string | undefined,
  mcpServers: ReturnType<typeof parseExternalMcpServers>,
  timeoutMs: number
): Promise<{
  content: string;
  model?: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  assistantRequestElapsedMs: number;
  firstTokenLatencyMs: number;
  streamElapsedMs: number;
}> => {
  const chunks: string[] = [];
  let activeRequestId: string | undefined;
  let firstChunkAt: number | undefined;
  let model: string | undefined;
  return await new Promise<{
    content: string;
    model?: string;
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
    assistantRequestElapsedMs: number;
    firstTokenLatencyMs: number;
    streamElapsedMs: number;
  }>((resolve, reject) => {
    const started = Date.now();
    const timer = setTimeout(() => {
      if (activeRequestId) {
        agent.cancel(activeRequestId);
      }
      reject(new Error('Inference prompt timed out.'));
    }, timeoutMs);
    agent
      .start(
        {
          projectId: groundTruthCase.projectId,
          recordId: groundTruthCase.caseId,
          message: prompt,
          history,
          systemPrompt: [
            systemPrompt,
            'Run deterministic inference for the attached ground truth input record. Produce the requested record updates through available tools.'
          ]
            .filter((part): part is string => Boolean(part?.trim()))
            .join('\n\n'),
          attachments: [
            {
              id: 'input-record',
              name: 'input.json',
              path: `ground-truth/${groundTruthCase.projectId}/${groundTruthCase.caseId}.json`,
              sizeBytes: Buffer.byteLength(JSON.stringify(groundTruthCase.input)),
              content: JSON.stringify(groundTruthCase.input, null, 2)
            }
          ],
          tools: tools.listTools(),
          mcpServers
        },
        {
          chunk: (chunk) => {
            firstChunkAt = firstChunkAt ?? Date.now();
            chunks.push(chunk.content);
          },
          complete: () => {
            clearTimeout(timer);
            const finished = Date.now();
            const firstTokenAt = firstChunkAt ?? finished;
            resolve({
              content: chunks.join(''),
              model,
              startedAt: new Date(firstTokenAt).toISOString(),
              finishedAt: new Date(finished).toISOString(),
              elapsedMs: finished - firstTokenAt,
              assistantRequestElapsedMs: finished - started,
              firstTokenLatencyMs: firstTokenAt - started,
              streamElapsedMs: finished - firstTokenAt
            });
          },
          error: (streamError) => {
            clearTimeout(timer);
            reject(new Error(streamError.error.message));
          },
          canceled: () => {
            clearTimeout(timer);
            reject(new Error('Inference prompt was canceled.'));
          },
          log: (event) => {
            if (event.event !== 'review-assistant.agent-provider-usage') {
              return;
            }
            const usageModel = event.fields.model;
            if (typeof usageModel === 'string' && usageModel.trim()) {
              model = usageModel.trim();
            }
          }
        },
        tools
      )
      .then((started) => {
        activeRequestId = started.requestId;
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

const createRecordingToolRuntime = (runtime: LocalToolRuntime, recorder: ToolCallRecorder): LocalToolRuntime => ({
  listTools: runtime.listTools,
  execute: async (request: ToolInvocationRequest): Promise<ToolInvocationResponse> => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const response = await runtime.execute(request);
    const finished = Date.now();
    const finishedAt = new Date(finished).toISOString();
    const elapsedMs = finished - started;
    const toolCall: InferenceToolCall = {
      tool: request.tool,
      input: cloneJson(request.arguments),
      ok: response.ok,
      result: response.ok ? cloneJson(response.result) : undefined,
      startedAt,
      finishedAt,
      elapsedMs,
      ...(response.ok
        ? {}
        : {
            error: {
              code: response.error.code,
              message: response.error.message
            }
          })
    };
    recorder.calls.push(toolCall);
    recorder.transcript.push({
      type: 'tool-call',
      startedAt,
      finishedAt,
      elapsedMs,
      success: response.ok,
      tool: request.tool,
      input: cloneJson(request.arguments),
      result: response.ok ? cloneJson(response.result) : undefined,
      ...(response.ok ? {} : { error: toolCall.error })
    });
    return response;
  }
});

const loadGroundTruthLocalToolPlugins = async (repoRoot: string): Promise<LocalToolPlugin[]> => {
  const plugins = await discoverLocalToolPlugins([path.join(repoRoot, 'ground-truth', 'config')]);
  const error = plugins.find((plugin): plugin is Error => plugin instanceof Error);
  if (error) {
    throw error;
  }
  return plugins.filter((plugin): plugin is LocalToolPlugin => !(plugin instanceof Error));
};

const stageGroundTruthCase = async (
  repoRoot: string,
  groundTruthCase: GroundTruthCase
): Promise<{ storage: LocalStorageAdapter; cleanup: () => Promise<void> }> => {
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-inference-'));
  const sourceProjectRoot = path.join(repoRoot, 'ground-truth', groundTruthCase.projectId);
  const stagedProjectRoot = path.join(stageRoot, groundTruthCase.projectId);
  await fs.mkdir(stagedProjectRoot, { recursive: true });
  await copyDirectoryIfExists(path.join(repoRoot, 'ground-truth', 'config'), path.join(stageRoot, 'config'));
  await fs.cp(path.join(sourceProjectRoot, 'config'), path.join(stagedProjectRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(stagedProjectRoot, `${groundTruthCase.caseId}.json`), `${JSON.stringify(groundTruthCase.input, null, 2)}\n`, {
    flag: 'wx'
  });
  const storage = createGroundTruthStorage(stageRoot);
  return {
    storage,
    cleanup: async () => {
      await fs.rm(stageRoot, { recursive: true, force: true });
    }
  };
};

const copyDirectoryIfExists = async (source: string, destination: string): Promise<void> => {
  try {
    await fs.cp(source, destination, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};

const createFailedCaseArtifact = (
  options: Pick<RunInferenceOptions, 'runFolder'>,
  iteration: string,
  ref: string,
  caseId: string,
  error: InferenceErrorPayload,
  groundTruthRoot: string,
  status: InferenceStatus,
  groundTruth: unknown = {}
): InferenceCaseArtifact => {
  const now = new Date().toISOString();
  const transcript: InferenceTranscriptEntry[] = [
    {
      type: 'event',
      startedAt: now,
      finishedAt: now,
      elapsedMs: 0,
      success: false,
      metadata: { event: 'ground-truth-load-error', root: groundTruthRoot },
      error
    }
  ];
  return {
    ref,
    iteration,
    runFolder: options.runFolder,
    caseId,
    model: undefined,
    startedAt: now,
    finishedAt: now,
    elapsedMs: 0,
    ground_truth: cloneJson(groundTruth),
    output: {},
    transcript,
    status,
    error
  };
};

export const manifestBlobPath = (runFolder: string): string =>
  `${safeBlobSegment(runFolder)}/manifest.json`;

export const caseArtifactPath = (runFolder: string, ref: string, iteration: string): string =>
  `${safeBlobSegment(runFolder)}/${safeBlobSegment(ref)}-${safeBlobSegment(iteration)}.json`;

const toWrittenInferenceJson = (artifact: InferenceCaseArtifact): WrittenInferenceJson => ({
  ground_truth: cloneJson(artifact.ground_truth),
  inference: {
    ref: artifact.ref,
    iteration: artifact.iteration,
    run_folder: artifact.runFolder,
    case_id: artifact.caseId,
    ...(artifact.model !== undefined ? { model: artifact.model } : {}),
    started_at: artifact.startedAt,
    finished_at: artifact.finishedAt,
    elapsed_ms: artifact.elapsedMs,
    output: cloneJson(artifact.output),
    transcript: sortTranscript(artifact.transcript).map(toWrittenTranscriptEntry),
    status: artifact.status,
    ...(artifact.error ? { error: cloneJson(artifact.error) } : {})
  }
});

const toWrittenTranscriptEntry = (entry: InferenceTranscriptEntry): WrittenInferenceTranscriptEntry => ({
  type: entry.type,
  started_at: entry.startedAt,
  finished_at: entry.finishedAt,
  elapsed_ms: entry.elapsedMs,
  success: entry.success,
  ...(entry.metadata ? { metadata: cloneJson(entry.metadata) } : {}),
  ...(entry.content !== undefined ? { content: entry.content } : {}),
  ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
  ...(entry.input !== undefined ? { input: cloneJson(entry.input) } : {}),
  ...(entry.result !== undefined ? { result: cloneJson(entry.result) } : {}),
  ...(entry.error ? { error: cloneJson(entry.error) } : {})
});

const sortTranscript = (transcript: InferenceTranscriptEntry[]): InferenceTranscriptEntry[] =>
  [...transcript].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

const safeBlobSegment = (value: string): string => {
  const segment = value.trim();
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new Error(`Invalid inference blob path segment: ${value}`);
  }
  return segment;
};

const countStatuses = (artifacts: InferenceCaseArtifact[]): Record<InferenceStatus, number> => ({
  completed: artifacts.filter((artifact) => artifact.status === 'completed').length,
  failed: artifacts.filter((artifact) => artifact.status === 'failed').length,
  timeout: artifacts.filter((artifact) => artifact.status === 'timeout').length
});

const assertUniqueCaseRefs = (cases: GroundTruthCase[]): void => {
  const refs = new Set<string>();
  for (const groundTruthCase of cases) {
    if (typeof groundTruthCase.ref !== 'string' || groundTruthCase.ref.trim() === '') {
      throw new Error(`Ground truth case is missing ref: ${groundTruthCase.caseId}`);
    }
    if (refs.has(groundTruthCase.ref)) {
      throw new Error(`Duplicate ground truth ref: ${groundTruthCase.ref}`);
    }
    refs.add(groundTruthCase.ref);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
