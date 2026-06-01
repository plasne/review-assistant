# Architecture

Review Assistant uses a secure Electron split with strict ownership across renderer, preload, main, and agent worker code.

## Boundaries

| Boundary | Input | Output | Owner |
|---|---|---|---|
| Renderer UI (`src/renderer`) | Typed preload API results and chat stream events | User interactions, view state, selected project/record identifiers | React renderer |
| Preload bridge (`src/preload`) | Renderer API calls and IPC events | Validated `window.reviewAssistant` methods and subscriptions | Preload |
| Main orchestration (`src/main/main.ts`) | Preload IPC requests | Storage results, chat lifecycle events, structured errors | Electron main |
| Storage adapters (`src/main/storage.ts`) | Validated project/record identifiers | Project summaries, record details, project prompts | Main storage layer |
| Local tool runtime (`src/main/tools.ts`) | Tool invocation requests from agent worker | Backend-neutral tool responses | Main tool layer |
| Agent runtime (`src/main/agent.ts`) | Chat context and stream handlers | Worker lifecycle, cancellation, tool request routing | Main agent layer |
| Agent worker (`src/agent/agent-process.ts`) | Chat context and MCP tool metadata | GitHub Copilot process output, MCP tool bridge requests | Isolated worker |

## Data Shape Contracts

- Parse and validate external data at process and storage boundaries.
- Renderer may pass only selected identifiers and user messages; it must not read files, Azure blobs, child processes, or local tools directly.
- Preload validates request arguments before invoking allowlisted IPC channels and validates responses/events before exposing them to renderer code.
- Main validates project identifiers, record identifiers, chat messages, and IPC payloads before crossing into storage or agent orchestration.
- Storage adapters implement one stable project contract: `listProjects`, `createProject`, `openProject`, `getRecord`, and `getProjectPrompt`.
- Local tool responses use `ToolInvocationResponse` with stable `requestId`, `ok`, `result`, and structured `error` fields.

## Execution Flow

1. The renderer selects a project and record through preload API calls.
2. Main opens projects and reads records through the configured `StorageAdapter`.
3. The renderer starts chat by sending the user message plus selected project/record identifiers.
4. Main assembles project prompt, selected record context identifiers, and local tool metadata.
5. The agent worker launches GitHub Copilot with an isolated temporary workspace and MCP configuration.
6. Copilot calls Review Assistant MCP tools when it needs selected record contents.
7. Tool calls return through the worker to main, where the trusted UI-selected project and record determine storage access.
8. Streamed chunks, completion, errors, and cancellation events return to the renderer through typed preload event bridges.

## Module Ownership Rules

- Renderer owns presentation, keyboard/mouse interactions, chat view state, and schema-driven read-only rendering.
- Preload owns IPC allowlisting and runtime validation at the renderer boundary.
- Main owns app lifecycle, config loading, backend selection, storage access, validation policy, local tool execution, and agent orchestration.
- Agent worker owns provider transport details, temporary directories, MCP server wiring, and process cleanup.
- Provider-specific logic must not leak into renderer components.
- Storage backends must stay behind `StorageAdapter`; local filesystem and Azure Blob details must not leak into renderer or agent worker code.

## Refactor Checklist

- Boundary contracts are unchanged or versioned.
- IPC invoke channels have matching `ipcMain.handle` registrations and smoke coverage.
- IPC event channels have matching main senders and preload bridges.
- Functional behavior changes include tests at the public boundary they affect.
- Observability events use documented names and fields.
