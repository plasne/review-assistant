<!-- markdownlint-disable-file -->
# Research: "pi" Integration — What It Is and How It Currently Works

**Subagent:** Researcher
**Date:** 2026-06-02
**Scope:** Identify what "pi" means in this application, what provider is actually integrated, and how the full agent integration pipeline is wired across all process boundaries.

---

## 1. Scope, Questions, and Assumptions

### Questions answered

1. What provider/client/API integration currently powers the application?
2. Which files and boundaries are involved?
3. What contracts, schemas, environment variables, settings, error handling, telemetry, and tests exist?
4. What constraints would an alternative SDK need to satisfy to preserve current behavior?
5. What implementation pitfalls should planning avoid?

### Assumptions

- "pi" in the requirements means the open-source `earendil-works/pi` coding-agent CLI (`@earendil-works/pi-coding-agent`).
- The implementation may or may not have adopted `pi`; actual code is the ground truth.
- The agent abstraction layer is the primary boundary of interest for SDK replacement.

---

## 2. Evidence Log

| Search/Read | Target | Finding |
|---|---|---|
| `grep -ri '\bpi\b'` on `src/` and `*.{ts,mjs,json,md}` | whole repo | Only one match: `requirements/v0.1.0.md:236` references `https://github.com/earendil-works/pi` |
| `view src/agent/agent-process.ts` | full file (23.6 KB) | Spawns `copilot` CLI via `spawn()`, bridges MCP via local TCP server |
| `view src/main/agent.ts` | full file | `AgentRuntime` — forks worker per chat via `node:child_process fork()` |
| `view src/main/main.ts` | full file | IPC channels, AgentRuntime init at line 36 |
| `view src/main/env.ts` | full file | Env var parsing, backend selection, secret redaction |
| `view src/main/mcp.ts` | full file | `_mcp.json` parsing and merge logic |
| `view src/main/tools.ts` | full file | `readRecord` and `listTools` built-in tools |
| `view src/preload/preload.ts` | full file | IPC channel allowlist and typed API bridge |
| `view src/shared/types.ts` | full file | All shared type contracts |
| `view src/shared/validators.ts` | partial | IPC payload validators |
| `view src/main/copilot-login.ts` | full file | Device-code parsing for Copilot auth flow |
| `view tests/unit/agent.test.ts` | full file | `normalizeProviderError` unit tests |
| `view tests/integration/agent-runtime.test.ts` | full file | End-to-end worker pipeline integration tests |
| `view tests/e2e/electron.spec.ts` | full file | Playwright E2E, uses `fake-copilot.mjs` |
| `view test-fixtures/fake-copilot.mjs` | full file | Copilot CLI stub with arg contract verification |
| `view scripts/smoke.mjs` | full file | IPC channel pairing smoke check |
| `view docs/ARCHITECTURE.md` | full file | Official boundary ownership table |
| `view docs/OBSERVABILITY.md` | full file | Event taxonomy, required fields |
| `view requirements/v0.1.0.md` | full file | "pi" reference at line 236 |
| `github get_file_contents earendil-works/pi /` | root listing | Confirms pi is a coding-agent monorepo |
| `github get_file_contents earendil-works/pi README.md` | README | pi packages: pi-coding-agent, pi-agent-core, pi-ai |
| `web_fetch https://pi.dev/docs/latest/json` | JSON event stream docs | pi has `--mode json` streaming events |
| `web_fetch https://pi.dev/docs/latest/rpc` | RPC mode docs | pi has `--mode rpc` stdin/stdout JSONL protocol |

---

## 3. Key Discoveries

### Discovery 1 — "pi" is referenced once in requirements but was NOT implemented

The only occurrence of "pi" in the repository source code is in `requirements/v0.1.0.md:236`:

```text
- Assume one local agent implementation based on <https://github.com/earendil-works/pi>.
```

**The actual implementation chose GitHub Copilot CLI instead.** Every source file, test, telemetry event, error message, and environment variable refers exclusively to GitHub Copilot. The `earendil-works/pi` library is not installed, not imported, and not invoked anywhere in the codebase.

### Discovery 2 — "pi" (earendil-works/pi) is a multi-provider coding-agent CLI

`earendil-works/pi` is an open-source TypeScript coding-agent monorepo with:

- `@earendil-works/pi-coding-agent` — interactive CLI agent, invokable as `pi`
- `@earendil-works/pi-agent-core` — agent runtime with tool calling and state management
- `@earendil-works/pi-ai` — unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.)

It supports three integration modes:

- **Interactive TUI** (`pi`)
- **JSON event stream** (`pi --mode json "prompt"`) — JSONL events on stdout
- **RPC mode** (`pi --mode rpc`) — stdin/stdout JSONL bidirectional protocol
- **SDK** — direct TypeScript import of `AgentSession` from `@earendil-works/pi-coding-agent`

### Discovery 3 — Current provider is GitHub Copilot CLI, spawned as a subprocess

The agent worker (`src/agent/agent-process.ts`) spawns the `copilot` binary (or a configured substitute) using Node.js `spawn()`. Streamed stdout chunks are read directly and relayed as IPC messages to the main process. The provider identity is hardcoded:

```typescript
// src/agent/agent-process.ts:50
const provider = { id: 'github-copilot' as const, name: 'GitHub Copilot' };

// src/main/agent.ts:83-86
const provider: AgentProviderMetadata = {
  id: 'github-copilot',
  name: 'GitHub Copilot'
};
```

### Discovery 4 — Copilot CLI is configured via a specific set of flags

`getCopilotCommand()` at `src/agent/agent-process.ts:510-542` assembles the command:

```text
copilot
  -C <tempDir>
  -p <prompt>
  --silent
  --stream on
  --no-color
  --no-custom-instructions
  --no-ask-user
  --disable-builtin-mcps
  --disallow-temp-dir
  [tool flags: either --available-tools none OR --additional-mcp-config @<path> --allow-all-tools --allow-tool review_assistant(<tool>) ...]
  --log-level error
```

These flags impose a specific CLI contract on any replacement provider: it must accept a prompt via `-p`, write streamed text to stdout, exit with code 0 on success, and support MCP configuration injection.

### Discovery 5 — MCP bridge is a localhost TCP server, not stdio

When tools are present, the worker:

1. Starts a localhost TCP server on a random port
2. Writes a temp `review-assistant-mcp-server.mjs` Node.js MCP server script
3. Writes a temp `mcp-config.json` configuring Copilot to use the Node.js MCP server
4. The Node.js MCP server receives MCP JSON-RPC from Copilot and bridges calls to the TCP socket
5. The TCP socket handler in the worker routes to main-process tool execution via IPC

Token-based auth (`REVIEW_ASSISTANT_TOOL_TOKEN`) guards the TCP socket.

### Discovery 6 — Status check is a dedicated lightweight copilot invocation

`checkStatus()` at `src/agent/agent-process.ts:197-238` spawns copilot with prompt `"Reply with exactly: OK"` and a 4.5 s timeout. Exit code 0 + non-empty stdout = `ready`. Any other outcome maps through `normalizeProviderError()` to a structured `AgentErrorEnvelope`.

### Discovery 7 — Error normalization is a stable contract surface

`normalizeProviderError()` maps raw stderr/exception messages to one of five stable error codes by substring matching: `BINARY_NOT_FOUND`, `AUTH_REQUIRED`, `CONTEXT_TOO_LARGE`, `REQUEST_CANCELED`, `PROVIDER_ERROR`. This logic exists in both `src/main/agent.ts:292-332` (for main-process-level failures) and `src/agent/agent-process.ts:679-720` (for worker-level failures). Both must remain in sync.

---

## 4. Architecture / Data Flow

```text
Renderer (React, sandbox)
  │  window.reviewAssistant.*  (typed preload API)
  ▼
Preload (contextBridge)
  │  ipcRenderer.invoke / ipcRenderer.on
  ▼
Main Process (Electron main)
  ├─ StorageAdapter  (local/Azure, behind abstraction)
  ├─ LocalToolRuntime (readRecord, listTools, plugin tools)
  └─ AgentRuntime
       │  node:child_process fork()  (one fork per request)
       ▼
    Agent Worker (src/agent/agent-process.ts)
       ├─ buildPrompt()  →  120,000 char limit
       ├─ createMcpConfig()  →  writes tempDir/mcp-config.json
       │    └─ starts TCP bridge server on random localhost port
       ├─ spawn(copilotCommand, copilotArgs, { cwd: tempDir })
       │    Copilot process
       │      ├─ reads prompt from -p arg
       │      ├─ calls review_assistant MCP tools via Node.js MCP server
       │      │    └─ Node.js MCP server → TCP socket → worker → IPC → main → storage
       │      └─ streams text to stdout
       ├─ stdout chunks → IPC {type:'chunk'} → main → webContents.send('chat:chunk')
       ├─ exit 0 → IPC {type:'complete'} → main → webContents.send('chat:complete')
       └─ non-zero exit → normalizeProviderError → IPC {type:'error'} → main → webContents.send('chat:error')

Telemetry: structured console logging via logInfo/logError
  review-assistant.* event names with requestId, elapsedMs, provider, projectId, recordId
```

**IPC channels (invoke):**

- `app:getBootstrap`, `projects:list`, `projects:create`, `projects:open`
- `records:get`, `feedback:getConfig`, `feedback:saveConfig`, `feedback:getProjectUser`, `feedback:submit`
- `agent:getStatus`, `chat:start`, `chat:cancel`

**IPC channels (event/push):**

- `chat:chunk`, `chat:complete`, `chat:error`, `chat:canceled`

---

## 5. Contracts, Schemas, Environment Variables, Settings, Error Handling, Telemetry, Tests

### Environment Variables

| Variable | Where consumed | Purpose | Secret? |
|---|---|---|---|
| `REVIEW_ASSISTANT_APP_ENV` | `src/main/env.ts:63-64` | Path to app `.env` file | No |
| `REVIEW_ASSISTANT_COPILOT_COMMAND` | `src/agent/agent-process.ts:545` | Binary name/path for copilot | No |
| `REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS` | `src/agent/agent-process.ts:546` | Newline-separated extra args | No |
| `AZURE_STORAGE_ACCOUNT_CONNSTRING` | `src/main/env.ts:51` | Azure backend connection | Yes (redacted) |
| `AZURE_STORAGE_ACCOUNT_NAME` | `src/main/env.ts:54` | Azure backend account name | No |
| `LOCAL_PATH` | `src/main/env.ts:57` | Local filesystem root | No |
| `REVIEW_ASSISTANT_TOOL_HOST` | agent-process.ts MCP_SERVER_SCRIPT | TCP bridge host | No |
| `REVIEW_ASSISTANT_TOOL_PORT` | agent-process.ts MCP_SERVER_SCRIPT | TCP bridge port | No |
| `REVIEW_ASSISTANT_TOOL_TOKEN` | agent-process.ts MCP_SERVER_SCRIPT | TCP bridge auth token (UUID) | Yes |
| `REVIEW_ASSISTANT_TOOLS_JSON` | agent-process.ts MCP_SERVER_SCRIPT | Tool metadata JSON | No |

### Type Contracts (src/shared/types.ts)

```typescript
AgentProviderMetadata  { id: 'github-copilot'; name: string }
AgentErrorCode         'BACKEND_UNAVAILABLE' | 'BINARY_NOT_FOUND' | 'AUTH_REQUIRED' |
                       'REQUEST_CANCELED' | 'CONTEXT_TOO_LARGE' | 'TOOL_NOT_FOUND' |
                       'INVALID_TOOL_ARGUMENTS' | 'NO_RECORD_SELECTED' | 'RECORD_NOT_FOUND' |
                       'PROVIDER_ERROR'
AgentErrorEnvelope     { code, message, retryable, remediation? }
AgentStatusSnapshot    { provider, availability: 'ready'|'unavailable', error? }
ChatStreamStartResult  { requestId, messageId }
ChatStreamChunk        { requestId, messageId, content }
ChatStreamComplete     { requestId, messageId }
ChatStreamError        { requestId, messageId?, error: AgentErrorEnvelope }
ChatCanceled           { requestId, messageId? }
LocalToolMetadata      { name, description, source, pluginId?, inputSchema }
ToolInvocationRequest  { tool, requestId, arguments }
ToolInvocationResponse { requestId, ok: true, result } | { requestId, ok: false, error }
```

### Prompt Constraints

- Max prompt: 120,000 characters (`MAX_PROMPT_CHARS` at `src/agent/agent-process.ts:48`)
- Prompt is assembled from: system instruction, project context, record context stubs, tool metadata JSON, external MCP server list, user message
- Record JSON is **NOT** included in the prompt — only identifiers; Copilot must call `readRecord` tool to retrieve content

### Error Handling

- Worker normalizes provider errors to `AgentErrorEnvelope` (two parallel copies: main/agent.ts and agent/agent-process.ts)
- Tool requests time out after 30,000 ms (`src/agent/agent-process.ts:471-487`)
- Copilot status check times out after 4,500 ms (`src/agent/agent-process.ts:204`)
- Main-level AgentRuntime status check times out after 5,000 ms (`src/main/agent.ts:93-116`)
- Cancellation: sends `SIGTERM` to process group (`process.kill(-child.pid, 'SIGTERM')`), then after 2 s kills child directly
- `AgentRuntimeError` wraps `AgentErrorEnvelope` for IPC error propagation (`src/main/agent.ts:285-290`)

### Telemetry Events (all `review-assistant.*`)

Defined in `docs/OBSERVABILITY.md`. Key events for the provider integration:

| Event | Where emitted | Fields |
|---|---|---|
| `review-assistant.agent-request-started` | `src/main/agent.ts:138` | provider, requestId, projectId, recordId, toolCount, tools, externalMcpServers, statusCheckMs |
| `review-assistant.agent-request-completed` | `src/main/agent.ts:203` | provider, requestId, elapsedMs |
| `review-assistant.agent-request-canceled` | `src/main/agent.ts:209` | provider, requestId, elapsedMs |
| `review-assistant.agent-request-failed` | `src/main/agent.ts:215` | provider, requestId, code, message, elapsedMs |
| `review-assistant.agent-worker-starting` | `src/agent/agent-process.ts:94` | requestId, toolCount, promptChars, mcpEnabled, externalMcpServers, setupMs |
| `review-assistant.agent-provider-spawned` | `src/agent/agent-process.ts:110` | requestId, pid, command, argCount, elapsedMs |
| `review-assistant.agent-first-output` | `src/agent/agent-process.ts:131` | requestId, elapsedMs |
| `review-assistant.agent-worker-completed` | `src/agent/agent-process.ts:176` | requestId, code, signal, elapsedMs |
| `review-assistant.tool-bridge-ready` | `src/agent/agent-process.ts:403` | requestId, port, toolCount, tools, externalMcpServers, elapsedMs |

### Tests Covering the Integration

| Test file | What it covers |
|---|---|
| `tests/unit/agent.test.ts` | `normalizeProviderError` — BINARY_NOT_FOUND, AUTH_REQUIRED, CONTEXT_TOO_LARGE |
| `tests/integration/agent-runtime.test.ts` | Worker streaming pipeline; tool invocation; cancellation; no-project context; external MCP; BINARY_NOT_FOUND; AUTH_REQUIRED; status-check timeout |
| `tests/e2e/electron.spec.ts` | Full Electron app with fake-copilot; chat flow with `FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS=1`; tool call through local MCP bridge |
| `test-fixtures/fake-copilot.mjs` | Stub verifying `--available-tools none`, `--additional-mcp-config`, `--allow-all-tools`, `--allow-tool review_assistant(*)`, external MCP config correctness, no embedded record JSON in prompt |

---

## 6. Compatibility Requirements for Replacing/Augmenting the Current Integration

Any alternative SDK or provider (including the original `earendil-works/pi`) must satisfy all of the following to preserve current behavior without breaking tests, IPC contracts, or the fake-copilot harness:

### A. Process model contract

- The replacement must run in the **agent worker process** (`src/agent/agent-process.ts`), invokable from `fork()` in main
- Provider transport must remain entirely within the worker; main process must not acquire provider-specific imports
- The worker communicates with main via IPC message types: `chunk`, `complete`, `error`, `canceled`, `status`, `toolRequest`, `log`

### B. Streaming output contract

- Text chunks must be emittable incrementally (either from stdout stream or SDK callbacks)
- Each chunk maps to `{ type: 'chunk', requestId, messageId, content: string }`
- Completion maps to `{ type: 'complete', requestId, messageId }`
- Errors map to normalized `AgentErrorEnvelope` with one of the defined `AgentErrorCode` values

### C. Status check contract

- Must support a lightweight availability check (no full chat) returning `{ provider, availability: 'ready'|'unavailable', error? }`
- Must complete or time out within ~4,500–5,000 ms
- Auth failure must produce error code `AUTH_REQUIRED`; missing binary must produce `BINARY_NOT_FOUND`

### D. Tool/MCP contract

- Tools are provided as `LocalToolMetadata[]` with `name`, `description`, `inputSchema` (JSON Schema)
- The provider must call tools via `ToolInvocationRequest` → `ToolInvocationResponse` round-trip (through whatever bridge mechanism)
- The MCP bridge pattern can be replaced by direct SDK tool-calling callbacks, but the tool execution still routes through main via IPC (required for storage access)
- `readRecord` and `listTools` must remain available to the provider; record JSON stays in main, never pre-loaded into the prompt

### E. Context size contract

- Must enforce `MAX_PROMPT_CHARS = 120_000` limit and return `CONTEXT_TOO_LARGE` error code if exceeded

### F. Cancellation contract

- Must support per-request cancellation while a chat is in flight
- After cancellation, must emit `{ type: 'canceled', requestId, messageId }` and clean up all resources (temp dirs, servers, child processes)

### G. Error normalization contract

- Must map ENOENT-like errors → `BINARY_NOT_FOUND`
- Must map auth/login errors → `AUTH_REQUIRED`
- Must map "context too large" → `CONTEXT_TOO_LARGE`
- Must map cancel events → `REQUEST_CANCELED`
- All other failures → `PROVIDER_ERROR` (retryable: true)

### H. Provider identity contract

- `AgentStatusSnapshot.provider.id` is currently `'github-copilot'` (literal type in `AgentProviderMetadata`)
- **If changing provider, `AgentProviderMetadata.id` type must be widened** or changed — this is a shared type breaking change across `src/shared/types.ts` and all validators

### I. Observability contract

- Must emit all `review-assistant.*` events defined in `docs/OBSERVABILITY.md` with the required fields
- `elapsedMs`, `requestId`, `provider`, `projectId`, `recordId`, `code` fields must remain stable

### J. Configuration contract

- Override of provider command/args via `REVIEW_ASSISTANT_COPILOT_COMMAND` / `REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS` (or equivalent) must be preserved for test harness substitution
- `fake-copilot.mjs` uses these env vars in E2E and integration tests; if provider changes, the fake must be updated accordingly

---

## 7. Potential Implementation Pitfalls

1. **Provider ID is a discriminated literal union** — `AgentProviderMetadata.id: 'github-copilot'` is a TypeScript literal type at `src/shared/types.ts:148`. Changing providers without widening this type will break compilation everywhere it's used.

2. **Two parallel copies of `normalizeProviderError`** — identical logic in `src/main/agent.ts:292` and `src/agent/agent-process.ts:679`. Both must be updated together when error normalization changes. Currently only the main-process version is unit-tested.

3. **Fake copilot contract is tight** — `test-fixtures/fake-copilot.mjs` asserts specific CLI flags (e.g., `--available-tools none`, `--additional-mcp-config`, `--allow-all-tools`). If the provider interface changes, the fake must be updated or tests will fail with exit code 44/45/46.

4. **MCP TCP bridge is per-request, ephemeral** — A new TCP server starts for every chat. If the provider is replaced with one that uses stdio-based MCP, the bridge architecture must change. The current design is tightly coupled to Copilot's `--additional-mcp-config` flag.

5. **Status check runs Copilot before every chat** — `AgentRuntime.start()` always calls `getStatus()` first, spawning a full Copilot process. For low-latency providers (e.g., in-process SDK calls), this adds unnecessary overhead. Caching or skip logic may be needed.

6. **Prompt is fully pre-rendered as a string** — The current approach embeds project prompt, record stubs, tool metadata, and MCP server list in a single text blob passed via `-p`. Multi-turn conversation, system/user role separation, and structured message arrays are not supported. Any SDK with a message-array API would require a prompt builder refactor.

7. **`NO_COLOR=1` is set in child environment** — If pi or another provider uses ANSI escape codes internally for progress (e.g., spinner), stdout might contain escape sequences. The `copilot-login.ts` ANSI stripper exists only for device-code parsing, not for the chat stream.

8. **Temp directory cleanup is async and best-effort** — `cleanupTempDir()` uses `fs.rm(..., { recursive: true, force: true })`. If cleanup fails (e.g., on Windows with locked files), MCP config files with token material may linger.

9. **Tool request timeout is 30 s** — Hardcoded at `src/agent/agent-process.ts:471`. Tools blocked on slow storage (e.g., Azure cold start) can time out and cause false `PROVIDER_ERROR` responses.

10. **`pi` has no `--silent` / `--no-color` / `--no-ask-user` equivalents** — `pi`'s CLI is TUI-first. Its non-interactive modes are `--mode json` (structured event stream) and `--mode rpc` (JSONL protocol). Directly substituting `pi` for `copilot` in the current subprocess-spawn approach would require a new output parser or use of pi's RPC/SDK mode instead.

---

## 8. Potential Next Research Gaps

1. **pi SDK integration pattern** — If `earendil-works/pi` is to be used, research the `AgentSession` SDK API (`packages/coding-agent/src/core/agent-session.ts`) to understand whether direct TypeScript import into the worker is feasible, what providers it needs (API keys vs. subscription), and how tool callbacks are registered.

2. **pi JSON/RPC mode compatibility** — Research whether `pi --mode json` or `pi --mode rpc` produces output compatible with the current streaming chunk protocol, and what event types map to `chunk`, `complete`, `error`, `canceled`.

3. **Provider auth flow** — The current `copilot-login.ts` only parses device-code prompts for the Copilot auth flow. If pi requires an API key or OAuth flow, research where credentials should live (main env, worker env, or keychain) and how they should be redacted in logs.

4. **Multi-turn / conversation history** — The current prompt is stateless (one string, no history). Research whether adding conversation memory requires changes to the `ChatContext` type, the IPC contracts, and the storage layer.

5. **Windows process group kill** — `process.kill(-child.pid, 'SIGTERM')` sends to the process group, which works on POSIX but not on Windows. Research the Windows cancellation path and whether the current fallback (`child.kill('SIGTERM')`) is sufficient.

6. **Prompt size for large schemas/tool lists** — The 120,000-char limit includes full tool `inputSchema` JSON for every tool. Research the practical limit under real project conditions and whether tool schema trimming or lazy loading is needed.
