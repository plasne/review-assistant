# review-assistant

Review Assistant is an Electron desktop app for reviewing inference records, collecting feedback, and letting GitHub Copilot update the currently selected project through safe local tools.

## Quick start

```bash
npm install
printf 'LOCAL_PATH=$PWD/data' > .env
npm run electron
```

`LOCAL_PATH` points at a directory of projects. Each project is a folder with:

| File           | Purpose                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `_schema.json` | JSON Schema for all record JSON files in the project.                           |
| `*.json`       | Review records. Files starting with `_` are reserved for project configuration. |
| `_prompt.md`   | Optional project-specific agent instructions.                                   |
| `_mcp.json`    | Optional project-specific external MCP connectors.                              |

## What the app supports

- Schema-driven read-only rendering for arbitrary customer record shapes, including nested objects, arrays, enums, nullable union types, `allOf`, and read-only fallback for complex JSON Schema constructs.
- Local and Azure-backed storage through the `StorageAdapter` boundary.
- Drafted record edits: inline edits, feedback, generated schemas, and local-tool writes are staged until the user saves.
- Feedback configuration per schema path, including ratings, comments, logged edits, and inline edits.
- GitHub Copilot chat with typed preload IPC, streaming responses, cancellation, bounded chat history, and metadata-only attachment selection.
- Main-owned local tools for reading the selected record, inspecting schemas, saving generated schemas, saving search results, and creating/completing schema-shaped conversation turns.
- External MCP connectors from app-level and project-level `_mcp.json` files.

## Harness

Prefer the stable Make targets:

```bash
make smoke
make check
make test
make ci
```

The underlying deterministic npm gates are `lint`, `typecheck`, `test:unit`, `test:integration`, `test:ui`, `test:e2e`, and `smoke`. `make audit-harness` verifies that the engineering harness and documentation anchors remain present.

## Schema coverage expectations

Customers can bring different schemas, so behavior should not depend on the sample project shape. Tests should cover schema behavior at public boundaries:

- Unit tests for validation/rendering in `tests/unit/schema.test.ts`.
- Local tool tests for schema-derived paths and turn targets in `tests/unit/tools.test.ts`.
- Storage integration tests for reading and writing project records.
- UI tests for renderer behavior using schema-generated `RenderNode` trees.
- E2E tests for real Electron IPC, preload, main, storage, and renderer wiring.

When adding schema-dependent behavior, include at least one regression that uses a non-sample schema.

## Agent prompts

Place `_prompt.md` next to the app `.env` to define default app instructions. A project can provide its own `_prompt.md`; when present, Review Assistant appends the app and project prompts in order for that request.

The generated request still appends current project/record identifiers, selected attachments, local Review Assistant tools, plugin tools, and external MCP server metadata after the selected prompt text.

## Agent settings

Set optional agent parameters in the app-level `.env` next to `LOCAL_PATH` or Azure storage settings:

```bash
AGENT_MODEL=gpt-5.5
REASONING_EFFORT=medium
```

`AGENT_MODEL` and `REASONING_EFFORT` are passed to the GitHub Copilot SDK session. Reasoning effort must be `low`, `medium`, `high`, or `xhigh`.

Claude Sonnet 4.6 was used during testing and was reliable for Review Assistant agent workflows.

Streaming is always enabled and is not configurable.

## Example agent requests

You can ask the agent for focused tasks in plain language. Example prompts:

- Give me a schema based on these attached docs.
- I want to answer the question "xxx".
- Create me a new turn.
- Search for "yyy".

## Chat attachments

The renderer can request text attachments through the preload API, but main owns file dialogs and file reads. Renderer-visible attachment objects contain only `id`, `name`, `path`, and `sizeBytes`; file content stays in main until `chat:start` resolves the cached attachment IDs. Removing an attachment discards its main-process cache entry.

## External MCP connectors

Drop an `_mcp.json` file next to the app `.env` to define MCP sources shared by all projects, or into a project to define project-specific sources. The file uses the standard `mcpServers` shape:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "allowedTools": ["search_code", "get_file_contents"]
    }
  }
}
```

`${NAME}` placeholders resolve from the project/app `.env` or process environment at chat start, so customers can use different sources and auth without changing application code. Secret-like values are redacted from renderer-visible project configuration and logs. Omit `allowedTools` to allow all tools exposed by that MCP server.

For each chat request, Review Assistant merges app-level and selected project-level MCP servers, then registers the merged set with the spawned Copilot process through a temporary MCP config. If app and project files define the same server id, the project-level definition overrides the app-level definition for that request.

## Engineering docs

- `docs/ARCHITECTURE.md` documents process boundaries, storage ownership, local tools, and refactor rules.
- `docs/OBSERVABILITY.md` documents stable `review-assistant.*` event names and logging fields.
- `AGENTS.md` documents agent operating rules and deterministic harness commands.
- `PLANS.md` records product/release planning notes.
