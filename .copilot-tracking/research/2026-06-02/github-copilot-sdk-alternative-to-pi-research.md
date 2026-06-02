<!-- markdownlint-disable-file -->
# Task Research: GitHub Copilot SDK as an Alternative to PI

Research whether GitHub Copilot SDK or adjacent GitHub-supported Copilot integration surfaces are a viable alternative to the current PI integration for the Review Assistant application.

## Task Implementation Requests

* Investigate what "pi" means in this application and how the existing integration works.
* Investigate GitHub Copilot SDK and adjacent supported GitHub Copilot integration surfaces.
* Evaluate viable implementation alternatives and select one recommended approach for this repository.

## Scope and Success Criteria

* Scope: Research-only analysis covering repository integration points, official GitHub Copilot/GitHub AI integration surfaces, compatibility constraints, and implementation implications for Review Assistant.
* Assumptions:
  * "PI" refers to an existing provider or platform integration in this repository that must be identified from codebase evidence.
  * The recommended approach should preserve this application's Electron architecture boundaries: renderer UI-only, typed preload IPC, main-owned orchestration/config/storage, and agent-owned provider transport/tool bridge details.
  * No source code outside `.copilot-tracking/research/` will be modified during this research task.
* Success Criteria:
  * A dated primary research document exists under `.copilot-tracking/research/2026-06-02/`.
  * Evidence includes code references with line ranges and external official-source citations where available.
  * Alternatives are evaluated with one selected approach and rationale.
  * Implementation impact, pitfalls, and next steps are actionable for a future planning phase.

## Outline

1. Current PI integration and Review Assistant provider architecture.
2. Official GitHub Copilot SDK/API/support surface landscape.
3. Compatibility requirements for replacing or augmenting PI.
4. Technical scenario alternatives.
5. Selected approach and implementation guidance.

## Potential Next Research

* Confirm target organization Copilot MCP policy, SDK bundled CLI version, and SDK test-mock seam before implementation.
  * Reasoning: These affect production readiness and test strategy, but do not change the recommended architecture.
  * Reference: `.copilot-tracking/research/subagents/2026-06-02/github-copilot-sdk-research.md`
* Deep-dive `earendil-works/pi` SDK, JSON mode, and RPC mode only if pi remains an implementation candidate.
  * Reasoning: Repository evidence shows pi is a requirements-era reference, not the implemented provider.
  * Reference: `.copilot-tracking/research/subagents/2026-06-02/current-pi-integration-research.md`

## Research Executed

### File Analysis

* `requirements/v0.1.0.md:236`
  * Only repository reference to "pi"; requirement says to assume one local agent implementation based on `https://github.com/earendil-works/pi`.
* `src/agent/agent-process.ts:50, 197-238, 316-425, 510-542, 679-720`
  * Worker hardcodes provider metadata to GitHub Copilot, checks availability by spawning `copilot`, creates a per-request localhost TCP MCP bridge, builds Copilot CLI args, and normalizes provider errors.
* `src/main/agent.ts:83-86, 93-116, 138, 173-184, 203-215, 292-332`
  * Main process exposes `AgentRuntime`, forks one worker per chat request, logs stable `review-assistant.*` events, and carries a second copy of provider error normalization.
* `src/shared/types.ts:148-150`
  * `AgentProviderMetadata.id` is currently the literal `'github-copilot'`, so provider replacement requires a shared type change.
* `tests/integration/agent-runtime.test.ts`, `tests/e2e/electron.spec.ts`, `test-fixtures/fake-copilot.mjs`
  * Integration and E2E coverage depend on a fake `copilot` command that validates the current CLI argument and MCP configuration contract.

### Code Search Results

* `\bpi\b`
  * Only match identified by the subagent: `requirements/v0.1.0.md:236`.
* Copilot/provider integration terms
  * Current implementation and tests consistently refer to GitHub Copilot CLI rather than pi.

### External Research

* GitHub repository: `earendil-works/pi`
  * pi is an open-source TypeScript coding-agent monorepo with `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai`.
* Web documentation: `https://pi.dev/docs/latest/json`
  * pi supports a JSON event stream mode via `pi --mode json`.
* Web documentation: `https://pi.dev/docs/latest/rpc`
  * pi supports stdin/stdout JSONL RPC mode via `pi --mode rpc`.
* GitHub Copilot SDK: `https://github.com/github/copilot-sdk`
  * Official SDK surface reported as GA, MIT-licensed, semantically versioned, and available for Node.js/TypeScript as `@github/copilot-sdk`.
* GitHub Copilot SDK Node.js README: `https://github.com/github/copilot-sdk/blob/main/nodejs/README.md`
  * Node.js SDK wraps Copilot CLI through JSON-RPC and bundles the CLI for Node.js use.
* GitHub Copilot SDK authentication docs: `https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md`
  * Supports stored Copilot login credentials, GitHub token environment variables, and explicit token configuration; classic `ghp_` PATs are not supported.
* GitHub Copilot SDK MCP docs: `https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md`
  * Supports first-class `mcpServers` configuration, which can replace the current temp-file `--additional-mcp-config` bridge.
* GitHub Copilot SDK BYOK docs: `https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md`
  * Supports provider configuration for OpenAI-compatible, Azure, and Anthropic routes.
* GitHub Models REST API: `https://docs.github.com/en/rest/models/inference?apiVersion=2022-11-28`
  * Public-preview REST inference endpoint supports streaming and tool-calling, but would require this app to implement its own agent loop and MCP client.
* Copilot Extensions: `https://github.com/copilot-extensions`
  * Relevant to building chat participants inside Copilot Chat, not embedding a provider in this standalone Electron app.

### Project Conventions

* Standards referenced: Repository instructions supplied in the conversation.
* Instructions followed: Research-only file changes limited to `.copilot-tracking/research/`; subagents delegated repository and external investigation.

## Key Discoveries

### Project Structure

The implemented provider path is GitHub Copilot CLI, not pi. The renderer remains UI-only behind `window.reviewAssistant.*`; preload owns typed IPC bridging; main owns storage, tools, config, telemetry, and `AgentRuntime`; the worker in `src/agent/agent-process.ts` owns provider transport and the MCP bridge. The worker spawns `copilot` with a rendered prompt and streams stdout back to main, while tool requests cross from Copilot MCP into a localhost TCP bridge, then worker IPC, then main-process tool execution.

### Implementation Patterns

The current provider integration is subprocess-oriented and test-harness friendly. `REVIEW_ASSISTANT_COPILOT_COMMAND` and `REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS` allow integration/E2E tests to substitute `test-fixtures/fake-copilot.mjs`. Any replacement must preserve a comparable substitution seam, streaming chunks, cancellation, normalized error envelopes, status checks, telemetry fields, and the rule that record JSON is fetched by tools rather than embedded in prompts.

### Complete Examples

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
  --additional-mcp-config @<path>
  --allow-all-tools
  --allow-tool review_assistant(<tool>)
  --log-level error
```

### API and Schema Documentation

Current shared contracts include `AgentProviderMetadata`, `AgentErrorEnvelope`, `AgentStatusSnapshot`, `ChatStreamStartResult`, `ChatStreamChunk`, `ChatStreamComplete`, `ChatStreamError`, `ChatCanceled`, `LocalToolMetadata`, `ToolInvocationRequest`, and `ToolInvocationResponse` in `src/shared/types.ts`. The implemented provider metadata type is currently narrow: `{ id: 'github-copilot'; name: string }`. The recommended SDK migration can preserve these shared types because the provider remains GitHub Copilot and the worker can adapt SDK events to the existing IPC event shapes.

### Configuration Examples

```text
REVIEW_ASSISTANT_COPILOT_COMMAND=<copilot command or fake command>
REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS=<newline-separated extra args>
REVIEW_ASSISTANT_TOOL_HOST=<localhost bridge host>
REVIEW_ASSISTANT_TOOL_PORT=<localhost bridge port>
REVIEW_ASSISTANT_TOOL_TOKEN=<per-request bridge token>
REVIEW_ASSISTANT_TOOLS_JSON=<serialized tool metadata>
```

## Technical Scenarios

### Replace direct Copilot CLI spawn with GitHub Copilot SDK

Repository evidence reframes the problem: pi was a requirements-era candidate, while the actual application already uses GitHub Copilot CLI. The relevant evaluation is whether a GitHub Copilot SDK or adjacent official GitHub-supported surface should replace the CLI subprocess contract or be introduced as an alternate worker-provider implementation.

**Requirements:**

* Preserve Electron security and process boundaries.
* Preserve existing provider behavior, streaming, tool execution, observability, and test coverage where applicable.
* Use official or supportable GitHub integration surfaces rather than relying on private or unstable APIs.
* Preserve or replace the test provider seam currently supplied by `REVIEW_ASSISTANT_COPILOT_COMMAND` and `test-fixtures/fake-copilot.mjs`.
* Keep tool execution routed through main-process IPC so storage access does not leak into renderer or provider transport.

**Preferred Approach:**

* Adopt `@github/copilot-sdk` inside the agent worker as the selected implementation path. It keeps the provider as GitHub Copilot, preserves the existing Electron/main/preload/renderer boundaries, replaces raw subprocess handling with an official typed SDK, removes the bespoke local TCP/MCP bridge for app-local tools, and allows external MCP servers to be passed through SDK `mcpServers` configuration.

```text
Recommended implementation file impact:
src/agent/agent-process.ts
src/main/agent.ts
src/main/copilot-login.ts
package.json
tests/integration/agent-runtime.test.ts
tests/e2e/electron.spec.ts
docs/OBSERVABILITY.md

Likely unchanged:
src/shared/types.ts
src/preload/preload.ts
src/main/main.ts
src/main/tools.ts
src/main/mcp.ts
src/main/storage.ts
src/renderer/
```

**Implementation Details:**

Current replacement constraints:

* Worker remains the provider boundary.
* Streaming maps to `chunk`, `complete`, `error`, and `canceled` IPC messages.
* Status checks must distinguish ready, auth-required, missing-provider, timeout, and provider-error states.
* Tool calls must preserve `ToolInvocationRequest` and `ToolInvocationResponse`.
* Provider errors must map to `BINARY_NOT_FOUND`, `AUTH_REQUIRED`, `CONTEXT_TOO_LARGE`, `REQUEST_CANCELED`, or `PROVIDER_ERROR`.
* Telemetry must keep stable `review-assistant.*` events and fields.
* SDK streaming events such as `assistant.message_delta` should be adapted to existing `chunk` events; `session.idle` should become `complete`; SDK error/cancellation paths should map through existing `AgentErrorEnvelope`.
* SDK `tools[]` handlers should call back to main through the existing worker IPC tool request/response protocol so storage and tool execution remain main-owned.
* SDK `mcpServers` should receive the already-parsed external MCP server config from `src/main/mcp.ts`; avoid leaking MCP or provider details into renderer code.

```text
See `.copilot-tracking/research/subagents/2026-06-02/current-pi-integration-research.md` for the full current-provider evidence log and compatibility contract.
See `.copilot-tracking/research/subagents/2026-06-02/github-copilot-sdk-research.md` for the SDK capability map, scenario analysis, and source citations.
```

#### Considered Alternatives

* **GitHub Models REST API:** Not selected. It supports streaming and tool-calling, but would require implementing an agentic tool loop, an MCP client, auth/token management, and production rate-limit planning. This adds more code and risk than the SDK path.
* **Copilot Extensions:** Not selected. They extend Copilot Chat in VS Code/GitHub surfaces and require a GitHub App callback endpoint; they do not embed a provider inside this standalone Electron app.
* **VS Code Chat Participant API:** Not selected. It applies to VS Code extensions, not this Electron app.
* **Keep raw Copilot CLI spawn:** Not selected as long-term architecture. It is the smallest tactical delta but retains temp dirs, bespoke MCP bridge code, stdout parsing, process-kill workarounds, and local binary installation requirements.
* **Direct pi substitution:** Not selected. pi is not implemented today and does not match the current Copilot CLI flag/stdout contract. pi-specific modes identified for possible rejection or fallback:

* Directly substituting `pi` for `copilot` is not compatible with the current CLI flags or stdout contract.
* `pi --mode json` or `pi --mode rpc` may be viable only with a new worker parser/protocol adapter.
* pi SDK import may be viable only if auth, streaming, tool-calling, and cancellation map cleanly to the current worker IPC contract.

### Selected Approach Summary

The selected approach is to migrate `src/agent/agent-process.ts` from direct `copilot` subprocess spawning to `@github/copilot-sdk` while preserving the forked worker boundary and existing renderer/preload/main contracts.

Evidence-based rationale:

* Same provider family and underlying Copilot capability as today, minimizing behavioral and licensing surprises compared with a new model provider.
* Official typed SDK replaces raw CLI flags, stdout parsing, status-check process spawns, SIGTERM cancellation, and temp-file MCP configuration.
* Local tools can be registered with SDK handlers while still executing through main-process IPC, preserving storage and architecture guardrails.
* External MCP servers can move from generated config files to SDK `mcpServers`.
* BYOK provider configuration provides a future enterprise path without switching app architecture.
* Implementation is concentrated in the worker and tests rather than renderer, preload, storage, and shared IPC surfaces.

### Follow-Up Items Before Implementation

* Confirm target org's Copilot MCP policy state.
* Confirm SDK bundled CLI version and feature parity for current session controls.
* Confirm SDK test seam or create an adapter interface so tests can mock the provider without live Copilot.
* Decide whether to retain, adapt, or deprecate `src/main/copilot-login.ts`.
* Decide whether `REVIEW_ASSISTANT_COPILOT_COMMAND` and `REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS` remain as test-only compatibility seams or are replaced by an SDK provider adapter mock.
