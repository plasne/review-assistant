# Observability

Review Assistant uses local console logging with stable event names and key-value fields. Logs must diagnose app startup, storage configuration, agent lifecycle, and local tool calls without exposing secrets or full record payloads.

## Required Event Fields

Every structured log line includes:

- `timestamp`: ISO-8601 timestamp emitted by `formatLogLine`.
- `event_name`: the `review-assistant.*` event string.

Long-running chat and tool workflows should also include:

- `requestId`: chat request correlation identifier.
- `toolRequestId`: tool request correlation identifier when a local tool is invoked.
- `provider`: active agent provider identifier when provider work is involved.
- `projectId`: selected project identifier or `none`.
- `recordId`: selected record identifier or `none`.
- `externalMcpServers`: comma-separated external MCP server identifiers configured for a chat request, or `none`.
- `elapsedMs`: elapsed duration for completed work.
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
| `review-assistant.agent-provider-canceled` | Agent worker canceled an active provider run. |
| `review-assistant.agent-provider-cancel-failed` | Provider cancellation failed. |
| `review-assistant.agent-provider-disconnect-failed` | SDK session disconnect failed during cleanup. |
| `review-assistant.agent-provider-stop-failed` | SDK runtime stop returned cleanup errors. |
| `review-assistant.agent-first-output` | Provider emitted the first streamed output. |
| `review-assistant.agent-worker-completed` | Agent worker completed provider execution. |
| `review-assistant.auth-login-started` | Main process started the GitHub Copilot SDK-bundled login flow. |
| `review-assistant.auth-device-code-ready` | Main process parsed a GitHub Copilot login device code and copied it for the renderer modal. |
| `review-assistant.auth-login-completed` | Main process observed the GitHub Copilot login process complete after device authorization. |
| `review-assistant.tool-request-started` | Worker forwarded a tool request to main. |
| `review-assistant.tool-execute-started` | Main started executing a local tool. |
| `review-assistant.tool-execute-completed` | Main completed local tool execution. |
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
- Harness failure rate by deterministic command in CI.
