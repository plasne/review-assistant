# Observability

Review Assistant uses local console logging with stable event names and key-value fields. Logs must diagnose app startup, storage configuration, agent lifecycle, and local tool calls without exposing secrets or full record payloads.

## Required Event Fields

Every structured log line includes:

- `timestamp`: ISO-8601 timestamp emitted by `formatLogLine`.
- `event_name`: the `review-assistant.*` event string.

Long-running chat and tool workflows should also include:

- `requestId`: chat request correlation identifier.
- `toolRequestId`: tool request correlation identifier when a local tool or external MCP tool is invoked.
- `provider`: active agent provider identifier when provider work is involved.
- `projectId`: selected project identifier or `none`.
- `recordId`: selected record identifier or `none`.
- `systemPromptSource`: `app`, `project`, `app+project`, or `none` for the prompt selected for a chat request.
- `systemPromptChars`: character count of the selected prompt.
- `attachmentCount`: number of selected chat attachments included in a request.
- `attachmentChars`: total character count of selected chat attachment content; file content is never logged.
- `externalMcpServers`: comma-separated external MCP server identifiers configured for a chat request, or `none`.
- `server`: external MCP server identifier for MCP tool call events.
- `tool`: local tool name or MCP server-local tool name.
- `sdkToolName`: provider/runtime tool name for external MCP tool call events.
- `agentSettings`: comma-separated configured agent setting keys, or `none`.
- `targetPath`, `containerPath`, `responseField`, `evidenceField`, `evidenceContainerPath`: schema locations reported by successful local persistence tools.
- `savedEvidenceCount`, `savedItemCount`, `containerItemCount`: counts reported by successful local persistence tools.
- `turnId`: provider loop turn identifier when emitted by the SDK.
- `model`, `inputTokens`, `outputTokens`, `reasoningTokens`, `timeToFirstTokenMs`: provider usage metadata when emitted by the SDK.
- `elapsedMs`: elapsed duration for completed work.
- `contextMs`: elapsed duration for main-process chat context assembly before the agent starts.
- `code`: stable error code for failed work.

## Event Taxonomy

| Event | Purpose |
|---|---|
| `review-assistant.config` | App-level config source, selected backend, and redacted values. |
| `review-assistant.project-config` | Project-level config merge with secrets redacted. |
| `review-assistant.config-error` | Startup configuration failures that block project browsing. |
| `review-assistant.chat-start-context` | Main-process chat context assembly summary. |
| `review-assistant.agent-request-started` | Agent runtime accepted a chat request. |
| `review-assistant.agent-request-completed` | Agent runtime completed a chat request. |
| `review-assistant.agent-request-canceled` | Agent runtime canceled a chat request. |
| `review-assistant.agent-request-failed` | Agent runtime failed a chat request with a structured error. |
| `review-assistant.agent-worker-starting` | Agent worker prepared prompt/tool context and is starting provider transport. |
| `review-assistant.agent-provider-spawned` | GitHub Copilot SDK session/runtime was initialized for a chat request. |
| `review-assistant.agent-provider-turn-started` | SDK agent loop turn started. |
| `review-assistant.agent-provider-turn-completed` | SDK agent loop turn completed, including elapsed time and reasoning delta counts when available. |
| `review-assistant.agent-provider-message-started` | SDK assistant message streaming started, including message ID and phase metadata only. |
| `review-assistant.agent-provider-reasoning-completed` | SDK reasoning block completed, including ID and character count only. |
| `review-assistant.agent-provider-usage` | SDK model usage metadata, including token counts and model-call timing when available. |
| `review-assistant.agent-provider-model-call-failed` | SDK model call failed, including status and correlation metadata without provider error payloads. |
| `review-assistant.agent-provider-canceled` | Agent worker canceled an active provider run. |
| `review-assistant.agent-provider-cancel-failed` | Provider cancellation failed. |
| `review-assistant.agent-provider-disconnect-failed` | SDK session disconnect failed during cleanup. |
| `review-assistant.agent-provider-stop-failed` | SDK runtime stop returned cleanup errors. |
| `review-assistant.inference-run-started` | Inference harness started a full inference run, including `runFolder`, iteration count, case counts, and per-prompt timeout. |
| `review-assistant.inference-case-started` | Inference harness started one ground truth case, including `runFolder`, `caseId`, and prompt count. |
| `review-assistant.inference-case-completed` | Inference harness completed one case, including status, elapsed time, and tool call count. |
| `review-assistant.inference-case-failed` | Inference harness failed one case with a structured code and elapsed time. |
| `review-assistant.inference-run-completed` | Inference harness uploaded run artifacts and manifest, including status counts and elapsed time. |
| `review-assistant.agent-first-output` | Provider emitted the first streamed output. |
| `review-assistant.agent-worker-completed` | Agent worker completed provider execution. |
| `review-assistant.tool-bridge-ready` | MCP bridge server is ready for local tool calls. |
| `review-assistant.mcp-server-started` | MCP server subprocess started. |
| `review-assistant.mcp-tools-list` | MCP client listed Review Assistant tools. |
| `review-assistant.mcp-tools-call` | MCP client requested a tool call. |
| `review-assistant.external-mcp-started` | External MCP proxy started for a configured server. |
| `review-assistant.external-mcp-tools-list-started` | Provider requested an external MCP server tool list. |
| `review-assistant.external-mcp-tools-list-completed` | External MCP server returned tool metadata. |
| `review-assistant.external-mcp-tool-call-started` | Provider started an external MCP tool call. |
| `review-assistant.external-mcp-tool-call-completed` | External MCP tool returned, with success, duration, and payload size metadata only. |
| `review-assistant.auth-login-started` | Main process started the GitHub Copilot SDK-bundled login flow. |
| `review-assistant.auth-device-code-ready` | Main process parsed a GitHub Copilot login device code and copied it for the renderer modal. |
| `review-assistant.auth-login-completed` | Main process observed the GitHub Copilot login process complete after device authorization. |
| `review-assistant.tool-request-started` | Worker forwarded a tool request to main. |
| `review-assistant.tool-execute-started` | Main started executing a local tool. |
| `review-assistant.tool-execute-completed` | Main completed local tool execution, with safe persistence metadata on successful tool results. |
| `review-assistant.tool-request-completed` | Worker received the tool response. |
| `review-assistant.tool-request-timeout` | Worker timed out waiting for a tool response. |

## Logging Rules

- Redact secret values such as `AZURE_STORAGE_ACCOUNT_CONNSTRING` as `****`.
- Do not log full record payloads, project prompts, provider prompts, or credential material.
- Keep event names and field names stable; add new fields rather than repurposing existing ones.
- Include enough context to replay failures from UI state: selected project, selected record, provider, request IDs, and stable error codes.

## Metrics To Derive

- Agent availability failure rate by `code`.
- Chat request duration from `review-assistant.agent-request-started` to completion/failure/cancel.
- Time to first output from SDK initialization (`review-assistant.agent-provider-spawned`) to `review-assistant.agent-first-output`.
- Local tool call count, duration, and failure rate by tool name.
- External MCP tool call count, duration, and failure rate by server and tool name.
- Provider model-call duration, time-to-first-token, and token counts from `review-assistant.agent-provider-usage`.
- Evidence persistence rate from `savedEvidenceCount` on `review-assistant.tool-execute-completed`.
- Harness failure rate by deterministic command in CI.
