# Architecture

Review Assistant uses a secure Electron split with strict ownership across renderer, preload, main, and agent worker code.

## Boundaries

| Boundary | Input | Output | Owner |
|---|---|---|---|
| Renderer UI (`src/renderer`) | Typed preload API results and chat stream events | User interactions, view state, selected project/record identifiers | React renderer |
| Preload bridge (`src/preload`) | Renderer API calls and IPC events | Validated `window.reviewAssistant` methods and subscriptions | Preload |
| Main orchestration (`src/main/main.ts`) | Preload IPC requests | Storage results, chat attachment metadata, chat lifecycle events, structured errors | Electron main |
| Storage adapters (`src/main/storage.ts`) | Validated project/record identifiers | Project summaries, record details, project prompts | Main storage layer |
| Local tool runtime (`src/main/tools.ts`) | Tool invocation requests from agent worker | Backend-neutral tool responses | Main tool layer |
| Agent runtime (`src/main/agent.ts`) | Chat context and stream handlers | Worker lifecycle, cancellation, tool request routing | Main agent layer |
| Agent worker (`src/agent/agent-process.ts`) | Chat context, local MCP tool metadata, and resolved external MCP server configs | GitHub Copilot process output, MCP tool bridge requests | Isolated worker |

## Data Shape Contracts

- Parse and validate external data at process and storage boundaries.
- Renderer may pass only selected identifiers and user messages; it must not read files, Azure blobs, child processes, or local tools directly.
- Chat file attachments are selected and read by main through Electron dialogs; renderer receives display metadata only and sends attachment identifiers back with the chat request.
- Removed chat attachments are discarded through an allowlisted IPC channel so cached file contents do not outlive the pending composer selection.
- Preload validates request arguments before invoking allowlisted IPC channels and validates responses/events before exposing them to renderer code.
- Main validates project identifiers, record identifiers, chat messages, and IPC payloads before crossing into storage or agent orchestration.
- Storage adapters implement one stable project contract: `listProjects`, `createProject`, `openProject`, `getRecord`, and `getProjectPrompt`.
- Agent instructions come from `_prompt.md` beside the app `.env` plus the selected project's `_prompt.md` when present.
- Local tool responses use `ToolInvocationResponse` with stable `requestId`, `ok`, `result`, and structured `error` fields.
- Project-level local tools, such as generated schema saves, use the selected project from trusted UI state and never accept project paths or identifiers from model-provided tool arguments.

## Execution Flow

1. The renderer selects a project and record through preload API calls.
2. Main opens projects and reads records through the configured `StorageAdapter`.
3. The renderer may request text file attachments through preload; main opens the system picker, reads selected text files, and caches their contents by attachment identifier.
4. The renderer starts chat by sending the user message plus selected project/record identifiers and attachment metadata.
5. Main resolves attachment identifiers from its cache, then assembles the selected app/project prompt, selected record context identifiers, attachment content, and local tool metadata.
6. Main resolves app-level external MCP connectors from `_mcp.json` beside the app `.env` and project-scoped connectors from the selected project's `_mcp.json`, including environment placeholders from app/project configuration.
7. The agent worker launches GitHub Copilot with an isolated temporary workspace and MCP configuration.
8. Copilot calls Review Assistant MCP tools when it needs selected record contents and may call allowlisted external MCP tools.
9. Local tool calls return through the worker to main, where the trusted UI-selected project and record determine storage access.
10. Streamed chunks, completion, errors, and cancellation events return to the renderer through typed preload event bridges.

## Module Ownership Rules

- Renderer owns presentation, keyboard/mouse interactions, chat view state, and schema-driven read-only rendering.
- Preload owns IPC allowlisting and runtime validation at the renderer boundary.
- Main owns app lifecycle, config loading, backend selection, app-level agent settings, storage access, validation policy, local tool execution, and agent orchestration.
- Main owns local chat attachment file access; renderer must not provide paths for main to read outside the main-owned attachment cache, and attachment cache entries are cleared after use or explicit discard.
- Main owns project schema writes; generated schemas are validated before replacing `_schema.json`, and existing schemas are backed up as `_schema_N.json`.
- Agent worker owns provider transport details, provider-specific agent setting application, temporary directories, MCP server wiring, and process cleanup.
- External MCP connector credentials remain in main/worker configuration and must not be exposed to the renderer. Project-level MCP server definitions override app-level definitions with the same server id for the active request.
- Provider-specific logic must not leak into renderer components.
- Storage backends must stay behind `StorageAdapter`; local filesystem and Azure Blob details must not leak into renderer or agent worker code.
- Schema-sensitive behavior must be tested with multiple schema shapes, not just the sample project schema.

## Refactor Checklist

- Boundary contracts are unchanged or versioned.
- IPC invoke channels have matching `ipcMain.handle` registrations and smoke coverage.
- IPC event channels have matching main senders and preload bridges.
- Functional behavior changes include tests at the public boundary they affect.
- Observability events use documented names and fields.
