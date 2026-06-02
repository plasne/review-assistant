<!-- markdownlint-disable-file -->
# Research: GitHub Copilot SDK as Alternative to Current "pi" Integration

Subagent research for the main agent task investigating GitHub Copilot SDK and GitHub-supported AI integration surfaces as alternatives to the current provider integration in Review Assistant.

## Index

| Section | Summary |
|---|---|
| Scope, Questions, Assumptions | Bounded research scope for the Review Assistant codebase |
| Current "pi" Integration Analysis | What the existing provider actually is: GitHub Copilot CLI subprocess spawn |
| GitHub Copilot Integration Surface Landscape | SDK, Copilot Extensions, GitHub Models, MCP, VS Code Chat |
| Capability Map to App Needs | How each surface maps to Electron + agent + tool workflow |
| Technical Scenario Analysis | Three viable options with pros/cons |
| Recommended Approach | `@github/copilot-sdk` to replace raw spawn |
| Evidence Log | Codebase citations and external doc URLs |
| Potential Next Research Gaps | What remains unverified |

---

## Scope, Questions, Assumptions, and Success Criteria

### Scope

- Codebase: `plasne/review-assistant` at `/Users/andrewvineyard/Engagements/ATT/review-assistant`
- Research date: 2026-06-02
- Research-only: no source code outside `.copilot-tracking/research/` was modified

### Research Questions

1. What is the current "pi" integration, and how does it work?
2. What official GitHub Copilot SDK(s), APIs, and supported surfaces exist as of 2026-06-02?
3. Which surfaces map to this app's needs (Electron, streaming, tool-calling, MCP, agent process)?
4. What are the implementation options and risks?
5. What is the recommended approach and why?

### Assumptions

- "pi" was not implemented as a named code entity. Repository evidence shows the current AI provider is GitHub Copilot CLI, invoked as a raw subprocess in `src/agent/agent-process.ts`.
- The recommended approach must preserve Electron security boundaries: renderer UI-only, typed preload IPC, main-owned orchestration, and agent-owned provider transport.
- Organizational licensing for GitHub Copilot Business/Enterprise may apply; see gap notes.

### Success Criteria

- [x] Evidence-backed analysis of the current integration
- [x] Enumeration of official GitHub Copilot/GitHub AI integration surfaces
- [x] Scenario analysis with pros/cons for viable alternatives
- [x] One recommended approach with implementation rationale
- [x] Codebase citations with line ranges and official external URLs

---

## Current "pi" Integration Analysis

### What "pi" Means

`pi` does not appear as an implemented provider in the codebase. The only repository reference identified by the companion subagent is `requirements/v0.1.0.md:236`, which says to assume one local agent implementation based on `https://github.com/earendil-works/pi`. Actual source code uses GitHub Copilot CLI.

### How the Current Integration Works

The integration spans three primary areas.

**`src/main/agent.ts`** (orchestration layer):

- Owns `AgentRuntime`, which `fork()`s the agent worker process per chat request (`src/main/agent.ts:173-184`).
- Declares provider metadata as `{ id: 'github-copilot', name: 'GitHub Copilot' }` (`src/main/agent.ts:83-86`).
- Injects CLI command override env vars into the forked worker: `REVIEW_ASSISTANT_COPILOT_COMMAND`, `REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS` (`src/main/agent.ts:178-183`).
- Maintains the worker IPC protocol: requests `start | cancel | status | toolResponse`; events `chunk | complete | error | canceled | status | log | toolRequest`.

**`src/agent/agent-process.ts`** (agent worker):

1. Creates a temp dir and bespoke MCP tool bridge (`src/agent/agent-process.ts:316-425`).
2. Writes an inline MCP server Node.js script (`MCP_SERVER_SCRIPT`) into the temp dir.
3. Starts a local TCP server on `127.0.0.1:<random port>` to receive tool-call JSON from the MCP script.
4. Writes `mcp-config.json` with the local tool bridge entry plus external MCP server entries.
5. Spawns `copilot` with a fully rendered prompt and CLI flags (`src/agent/agent-process.ts:93-194`, `src/agent/agent-process.ts:510-541`).
6. Streams `child.stdout` data back to main as `chunk` events (`src/agent/agent-process.ts:125-135`).
7. Routes MCP tool calls over TCP to worker IPC and then to main-process `LocalToolRuntime` (`src/agent/agent-process.ts:427-465`, `src/main/tools.ts:28-31`).
8. Performs status checks by spawning a fresh CLI process with prompt `Reply with exactly: OK` and a 4500 ms timeout (`src/agent/agent-process.ts:197-238`).

Current CLI shape:

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
  --additional-mcp-config @<configPath>
  --allow-all-tools
  --allow-tool review_assistant(<tool>)
  --log-level error
```

**`src/main/copilot-login.ts`**:

- Parses device-code prompts emitted by `copilot login`.
- May need review if SDK-managed authentication replaces explicit CLI-login handling.

### Current Pain Points

- Requires `copilot` CLI on PATH unless `REVIEW_ASSISTANT_COPILOT_COMMAND` is configured.
- Cold-starts a CLI process for both status checks and chat requests.
- Maintains a bespoke MCP bridge with TCP sockets, inline server script, temp files, token handling, and cleanup.
- Treats prompt as a single raw text string passed via `-p`; no SDK-level session history.
- Uses process-group kill workarounds for cancellation (`src/agent/agent-process.ts:264-273`).
- Requires careful fake-CLI substitution in tests (`test-fixtures/fake-copilot.mjs`).

---

## GitHub Copilot Integration Surface Landscape (as of 2026-06-02)

### 1. GitHub Copilot SDK (`@github/copilot-sdk`)

**Repository:** `github/copilot-sdk`  
**URL:** https://github.com/github/copilot-sdk  
**Status:** Generally Available (GA), semantic versioning  
**NPM package:** `@github/copilot-sdk`  
**Languages:** TypeScript/Node.js, Python, Go, .NET, Java, Rust

Architecture:

```text
Application -> SDK Client -> JSON-RPC -> Copilot CLI server mode
```

For Node.js, the SDK bundles the Copilot CLI binary automatically, so a separate user-installed `copilot` binary is not required.

Authentication methods identified:

1. Explicit `gitHubToken` passed to `CopilotClient` options or session config.
2. `COPILOT_HMAC_KEY` / `CAPI_HMAC_KEY` environment variables.
3. `GITHUB_COPILOT_API_TOKEN` + `COPILOT_API_URL` environment variables.
4. `COPILOT_GITHUB_TOKEN` -> `GH_TOKEN` -> `GITHUB_TOKEN` environment variables.
5. Stored OAuth credentials from `copilot login`.
6. `gh auth` GitHub CLI credentials.

Supported token types: `gho_` OAuth, `ghu_` GitHub App user, and `github_pat_` fine-grained PAT. Classic `ghp_` PATs are not supported.

Capabilities:

- Native typed streaming events including `assistant.message_delta`, `assistant.message`, `session.idle`, tool events, error events, and session lifecycle events.
- First-class tool calling by passing `tools` with handler functions to `createSession()`.
- First-class MCP server integration by passing `mcpServers` in `SessionConfig`.
- Supports local/stdio and HTTP/SSE MCP servers plus per-server tool allowlists.
- `client.start()`, `client.stop()`, `client.createSession()`, `session.send()`, `session.sendAndWait()`, `session.disconnect()`, and `client.resumeSession()`.
- `client.ping()` for lightweight connectivity/status checks.
- OpenTelemetry integration through `telemetry` config.
- BYOK provider config for OpenAI-compatible, Azure, and Anthropic model providers.

### 2. GitHub Models REST API

**URL:** https://docs.github.com/en/rest/models/inference?apiVersion=2022-11-28  
**Endpoint:** `POST https://models.github.ai/inference/chat/completions`  
**Status:** Public Preview as of research date  
**Auth:** PAT with `models:read` scope or GitHub App token

Capabilities:

- OpenAI-compatible chat-completions format.
- Streaming and non-streaming responses.
- Tool-calling via `tools` and `tool_choice`.
- Structured JSON output.
- Multiple model families.
- Org-attributed inference endpoints.

Limitations for this app:

- Requires manual agentic tool loop implementation.
- Requires a separate MCP client implementation.
- Requires PAT collection/storage flow not currently present.
- Free-tier limits are too restrictive for likely production review workflows.
- Enterprise owners must enable GitHub Models and configure allowed models.

### 3. Copilot Extensions

**URL:** https://github.com/copilot-extensions  
**Status:** GA  
**SDK:** `copilot-extensions/preview-sdk.js`

Copilot Extensions build `@agent-name` chat participants inside Copilot Chat in VS Code, GitHub.com, and GitHub Mobile. They require a GitHub App and internet-accessible callback endpoint. They are not suitable for embedding a provider inside this standalone Electron application.

### 4. MCP

MCP is already part of this application. Current Copilot CLI support uses `--additional-mcp-config @<path>`; the SDK provides first-class `mcpServers` config in `SessionConfig`. Copilot Business/Enterprise org policy for MCP servers may affect external MCP use and must be confirmed for deployment.

### 5. VS Code Chat Participant API

Not relevant because Review Assistant is a standalone Electron app, not a VS Code extension.

### 6. GitHub Copilot CLI Direct Subprocess

This is the current approach. It is GA and proven in the app, but the SDK wraps the same underlying capability through JSON-RPC with session management, typed streaming, tool handling, and bundled binary support.

---

## Capability Map to App Needs

| App Need | Current CLI Spawn | `@github/copilot-sdk` | GitHub Models API |
|---|---|---|---|
| Electron boundary | Agent worker via `fork()` | Same: SDK in forked worker | Same: REST in forked worker |
| Renderer/preload | No change | No change | No change |
| Chat streaming | Raw stdout chunks | `assistant.message_delta` events | SSE parsing |
| Tool-calling | Bespoke TCP/MCP bridge | `tools[]` handlers | Manual agent loop |
| MCP server integration | Temp MCP config file | `mcpServers` config | Implement MCP client |
| Local tool execution | TCP -> worker IPC -> main | Handler -> worker IPC -> main | Tool call parse -> worker IPC -> main |
| Status check | Spawn fresh CLI process | `client.ping()` | Models catalog/check request |
| Cancellation | SIGTERM/process-group kill | `session.disconnect()` | `AbortController` |
| Stored auth | `copilot login` | Same stored credentials | Not applicable |
| Env auth | Copilot tokens | Copilot/GitHub token chain | `models:read` token |
| BYOK | Not native | Session `provider` config | Direct endpoint/config |
| Binary installation | User-installed CLI | Bundled for Node.js | No binary |
| Session persistence | None | `resumeSession()` | Manual |
| Multi-turn history | Not implemented | Built-in session history | Manual messages array |
| Tests | Fake `copilot`/mock spawn | Mock SDK client/transport | Mock fetch |

---

## Technical Scenario Analysis

### Scenario A: Migrate agent worker to `@github/copilot-sdk` (Recommended)

**Summary:** Replace raw `spawn(copilot, [...flags])` in `src/agent/agent-process.ts` with `CopilotClient` from `@github/copilot-sdk`. Keep the existing `fork()` worker model, main/preload/renderer boundaries, storage, tool runtime, and MCP config parsing.

**Implementation impact:**

| File | Change |
|---|---|
| `src/agent/agent-process.ts` | Significant rewrite: remove `spawn()`, TCP socket server, `MCP_SERVER_SCRIPT`, `getCopilotCommand()`, `createMcpConfig()`, temp-dir MCP config; add `CopilotClient`, `createSession({ tools, mcpServers })`, streaming event handlers, and SDK cancellation/status handling. |
| `src/main/agent.ts` | Minor: remove or adapt CLI env var injection from `forkWorker()`. |
| `src/main/copilot-login.ts` | Evaluate retention, adaptation, or deprecation. |
| `package.json` | Add `@github/copilot-sdk` dependency. |
| `tests/unit/`, `tests/integration/`, `tests/e2e/` | Replace fake CLI expectations with SDK mock or injectable provider adapter. |

Unaffected surfaces: `src/shared/types.ts`, `src/preload/preload.ts`, `src/main/main.ts` IPC channels, `src/main/tools.ts`, `src/main/mcp.ts`, storage adapters, and renderer UI.

Tool bridge after migration:

```typescript
const session = await client.createSession({
  model: 'gpt-4.1',
  tools: context.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    handler: async (args: Record<string, unknown>) => {
      const response = await executeLocalToolViaIpc({
        tool: tool.name,
        requestId: randomUUID(),
        arguments: args,
      });
      return response.ok ? response.result : { error: response.error.message };
    },
  })),
  mcpServers: buildMcpServersFromConfig(context.mcpServers),
  streaming: true,
});
```

Streaming after migration:

```typescript
session.on('assistant.message_delta', (ev) => {
  process.send?.({ type: 'chunk', requestId, messageId, content: ev.data.deltaContent });
});

session.on('session.idle', () => {
  process.send?.({ type: 'complete', requestId, messageId });
  cleanup();
});
```

**Advantages:**

- Replaces raw subprocess flags and stdout parsing with an official typed SDK.
- Removes bespoke TCP/MCP bridge code and temp-file MCP config.
- Bundles Copilot CLI for Node.js, reducing user setup and `BINARY_NOT_FOUND` risk.
- Allows persistent client lifecycle and lower cold-start overhead.
- Uses typed streaming, error, session, and cancellation events.
- Provides BYOK path without an application architecture change.
- Preserves existing app process boundaries and IPC contracts.

**Limitations and risks:**

- Still governed by Copilot subscription/quota unless BYOK is configured.
- Bundled CLI version is tied to the SDK package version.
- Test harness must shift from fake CLI to SDK/client/transport injection.
- External MCP server support may depend on target org policy.

**Verdict:** Recommended. It is the closest functional match to the current provider while replacing the highest-risk custom integration code with an official GitHub-supported interface.

### Scenario B: Migrate agent worker to GitHub Models REST API

**Summary:** Replace Copilot CLI with direct REST calls to GitHub Models inference endpoint.

**Advantages:**

- Does not require a Copilot subscription.
- Supports multiple model families.
- Uses standard OpenAI-compatible request/response shape.
- No local binary needed.

**Limitations:**

- Requires manual tool-call loop and MCP client implementation.
- Requires PAT/GitHub App token management not currently present.
- Free-tier rate limits are unsuitable for production-scale review workloads.
- GitHub Models enterprise feature and allowed models must be enabled/configured.
- Adds more code, tests, and long-term maintenance than SDK migration.

**Verdict:** Not recommended as the primary path. Consider only if Copilot subscription is unavailable and the team accepts a larger provider implementation.

### Scenario C: Keep direct Copilot CLI spawn and improve it tactically

**Summary:** Keep current CLI subprocess approach, but refactor lifecycle, cleanup, and process reuse.

**Advantages:**

- Smallest implementation delta.
- No new dependency.
- Existing tests and fake CLI remain close to current shape.

**Limitations:**

- Retains temp dirs, bespoke MCP bridge, stdout parsing, process-kill workarounds, binary PATH requirement, and no BYOK path.
- Does not align with the official SDK integration surface.

**Verdict:** Acceptable only for short-term stabilization. Not recommended as the long-term architecture.

---

## Recommended Approach

### Adopt `@github/copilot-sdk` in the agent worker

The selected approach is to migrate the provider transport in `src/agent/agent-process.ts` from direct Copilot CLI subprocess spawning to `@github/copilot-sdk`, while preserving the existing forked worker boundary and IPC contracts.

Rationale:

1. **Same underlying engine, better interface.** The SDK wraps the same Copilot CLI capability but exposes a typed API instead of raw flags, stdout parsing, and temp-file configuration.
2. **Tool bridge simplification.** SDK tool handlers replace the app's bespoke TCP socket bridge while keeping actual tool execution routed through main-process IPC.
3. **MCP simplification.** External MCP servers can be passed as `mcpServers` instead of writing temporary MCP config files.
4. **Operational improvement.** SDK-bundled CLI reduces installation friction and a persistent client can reduce per-request cold starts.
5. **Better lifecycle.** `client.ping()` and `session.disconnect()` replace status-check and cancellation subprocess workarounds.
6. **Boundary preservation.** Renderer, preload, storage adapters, main IPC channels, and `LocalToolRuntime` do not need architectural changes.
7. **Future extensibility.** BYOK provider config offers a path to Azure AI Foundry/OpenAI/Anthropic without switching application architecture again.

---

## Evidence Log

### Codebase Citations

| Claim | Citation |
|---|---|
| Current provider ID: `'github-copilot'` | `src/main/agent.ts:83-86` |
| Worker forked with `fork()` | `src/main/agent.ts:173-184` |
| CLI command injected via `REVIEW_ASSISTANT_COPILOT_COMMAND` | `src/agent/agent-process.ts:544-547` |
| CLI flags include `--silent`, `--stream on`, `--additional-mcp-config`, `--allow-tool`, and `--log-level error` | `src/agent/agent-process.ts:510-541` |
| Bespoke TCP MCP bridge uses `net.createServer` on localhost | `src/agent/agent-process.ts:334-364` |
| Inline `MCP_SERVER_SCRIPT` embedded in agent worker | `src/agent/agent-process.ts:549+` |
| Tool bridge TCP handler validates token and sends tool IPC | `src/agent/agent-process.ts:427-465` |
| Tool IPC from worker to main | `src/agent/agent-process.ts:500-502` |
| Status check spawns CLI with probe prompt and 4500 ms timeout | `src/agent/agent-process.ts:197-238` |
| Prompt limit and construction | `src/agent/agent-process.ts:48, 275-307` |
| Worker IPC protocol types | `src/main/agent.ts:30-66` |
| External MCP config parsing and merging | `src/main/mcp.ts:11-42` |
| `LocalToolRuntime` interface | `src/main/tools.ts:28-31` |
| `AgentErrorCode.BINARY_NOT_FOUND` | `src/shared/types.ts:152-162` |
| `normalizeProviderError` maps `ENOENT` to `BINARY_NOT_FOUND` | `src/main/agent.ts:292-305` |
| Device-code login parser | `src/main/copilot-login.ts:1-25` |
| Process-group kill workaround | `src/agent/agent-process.ts:264-273` |
| Architecture boundary rules | `docs/ARCHITECTURE.md:1-55` |
| Agent worker path from main | `src/main/main.ts:36` |

### External Source Citations

| Source | URL | Date |
|---|---|---|
| GitHub Copilot SDK repository | https://github.com/github/copilot-sdk | 2026-06-02 |
| SDK Node.js/TypeScript README | https://github.com/github/copilot-sdk/blob/main/nodejs/README.md | 2026-06-02 |
| SDK Getting Started Guide | https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md | 2026-06-02 |
| SDK Authentication docs | https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md | 2026-06-02 |
| SDK Authentication index | https://github.com/github/copilot-sdk/blob/main/docs/auth/index.md | 2026-06-02 |
| SDK BYOK documentation | https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md | 2026-06-02 |
| SDK MCP integration docs | https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md | 2026-06-02 |
| SDK Features index | https://github.com/github/copilot-sdk/blob/main/docs/features/index.md | 2026-06-02 |
| GitHub Models REST API | https://docs.github.com/en/rest/models/inference?apiVersion=2022-11-28 | 2026-06-02 |
| GitHub Models rate limits | https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models | 2026-06-02 |
| About GitHub Models | https://docs.github.com/en/github-models/about-github-models | 2026-06-02 |
| MCP for GitHub Copilot CLI | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | 2026-06-02 |
| Copilot Extensions overview | https://docs.github.com/en/copilot/building-copilot-extensions/about-building-copilot-extensions | 2026-06-02 |
| copilot-extensions organization | https://github.com/copilot-extensions | 2026-06-02 |
| `@github/copilot-sdk` NPM package | https://www.npmjs.com/package/@github/copilot-sdk | 2026-06-02 |

---

## Potential Next Research Gaps

1. **Org MCP policy impact.** Confirm whether the target org has MCP servers enabled for Copilot Business/Enterprise users.
2. **SDK bundled CLI version and feature parity.** Confirm session-level equivalents for current CLI flags such as `--disable-builtin-mcps` and `--disallow-temp-dir`.
3. **Classic PAT and login flow.** Confirm whether `copilot-login.ts` should be kept, adapted, or deprecated; classic `ghp_` PATs are not supported by SDK token auth.
4. **Multi-user token isolation.** Validate per-session `gitHubToken` behavior if shared-workstation or multi-user scenarios matter.
5. **Quota impact.** Confirm Copilot premium request quota headroom for heavy review workloads and document BYOK fallback if needed.
6. **Test mock surface.** Confirm whether the SDK exposes mockable interfaces or transport injection points so tests do not require live Copilot access.

---

*Subagent research completed: 2026-06-02. All codebase claims were reported as verified against `/Users/andrewvineyard/Engagements/ATT/review-assistant`. External URLs were reported as fetched and confirmed live as of the research date.*
