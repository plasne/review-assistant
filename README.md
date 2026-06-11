# review-assistant

Review Assistant is an Electron desktop app for reviewing inference records, collecting feedback, and letting GitHub Copilot update the currently selected project through safe local tools.

## Quick start

```bash
npm install
mkdir -p data/config
printf 'LOCAL_PATH=$PWD/data' > .env
npm run electron
```

Root `.env` selects the project backend with `LOCAL_PATH`, `AZURE_STORAGE_ACCOUNT_CONNSTRING`, or `AZURE_STORAGE_ACCOUNT_NAME` plus `AZURE_STORAGE_CONTAINER`. `LOCAL_PATH` points at a directory of projects. App-level settings, defaults, and plug-ins live in `LOCAL_PATH/config`. Azure Blob storage uses the same logical layout inside `AZURE_STORAGE_CONTAINER`: root `config/` for app-level files and one folder per project. Each project is a folder with:

| File                 | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `config/.env`        | Optional project environment settings.                |
| `config/schema.json` | JSON Schema for all record JSON files in the project. |
| `config/config.json` | Optional schema-path review configuration.            |
| `config/mcp.json`    | Optional external MCP connectors.                     |
| `config/prompt.md`   | Optional agent instructions.                          |
| `config/tags.json`   | Optional manual tag definitions.                      |
| `*.json`             | Review records.                                       |

Local storage uses atomic file writes for record and schema updates. Azure Blob storage uses Blob ETags and conditional uploads for drafted record saves, new-record creation, and generated schema saves so stale writes fail instead of overwriting newer blob revisions.

App-level tag defaults and computed tag plug-ins can live in the app `LOCAL_PATH/config/` folder next to `LOCAL_PATH/config/.env`. Project-level `config/tags.json` files take precedence over app-level manual tag definitions with the same tag name. Executable computed tag plug-ins are loaded only from the app-level config folder so opening a project never executes project-supplied code.

### Manual tags

Create manual tag definitions in `config/tags.json`. The file can be either an array of definitions or an object with a `tags` array:

```json
[
  {
    "name": "needs-review",
    "description": "The record needs a human follow-up."
  }
]
```

Each definition needs a non-empty `name` and `description`. Names are trimmed, capped at 100 characters, and de-duplicated by load order: project-level definitions load first, then app-level definitions.

### Computed tag plug-ins

Place computed tag plug-ins in app-level `config/*.mjs` next to the app `config/.env`. JavaScript files inside project `config/` folders are ignored. Blob-backed app-level plug-ins are not executed; computed tag plug-ins run only from trusted local app config folders. A plug-in must export an object with a synchronous `tag(record, context)` function:

```js
const readTags = (record, pointer) => {
  if (pointer !== '/tags') {
    throw new Error(`Unsupported tags path: ${pointer}`);
  }
  return Array.isArray(record.tags) ? record.tags : [];
};

export default {
  name: 'turn-count',
  tag(record, context) {
    const tags = readTags(record, context.tagsPath).filter((tag) => !tag.startsWith('turns:'));
    record.tags = [...tags, Array.isArray(record.turns) && record.turns.length > 1 ? 'turns:multi' : 'turns:single'];
  }
};
```

The context includes `schema`, `tagsPath`, and `manualTagDefinitions`. Plug-ins run in deterministic file order, and each plug-in failure is reported without preventing other plug-ins from running or the save from completing. Final persisted tags must be an array of strings with at most 100 entries, and each tag must be 100 characters or fewer.

## What the app supports

- Schema-driven read-only rendering for arbitrary customer record shapes, including nested objects, arrays, enums, nullable union types, `allOf`, and read-only fallback for complex JSON Schema constructs.
- Local and Azure-backed storage through the `StorageAdapter` boundary.
- Drafted record edits: inline edits, feedback, generated schemas, and local-tool writes are staged until the user saves.
- Feedback configuration per schema path, including ratings, comments, logged edits, and inline edits.
- GitHub Copilot chat with typed preload IPC, streaming responses, cancellation, bounded chat history, and metadata-only attachment selection.
- Main-owned local tools for reading the selected record, inspecting schemas, saving generated schemas, saving search results, and creating/completing schema-shaped conversation turns.
- External MCP connectors from app-level and project-level `config/mcp.json` files.

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

Place `prompt.md` next to the app `LOCAL_PATH/config/.env` to define default app instructions. A project can provide its own `config/prompt.md`; when present, Review Assistant appends the app and project prompts in order for that request.

The generated request still appends current project/record identifiers, selected attachments, local Review Assistant tools, plugin tools, and external MCP server metadata after the selected prompt text.

## Agent settings

Set backend location keys in root `.env`. Azure storage also requires `AZURE_STORAGE_CONTAINER`, the single container that holds root `config/` and project folders. Set optional agent parameters in the app-level `config/.env` (`LOCAL_PATH/config/.env` for local storage, or root `config/.env` inside the Azure container):

```bash
AGENT_MODEL=gpt-5.5
REASONING_EFFORT=medium
```

`AGENT_MODEL` and `REASONING_EFFORT` are passed to the GitHub Copilot SDK session. Reasoning effort must be `low`, `medium`, `high`, or `xhigh`.

Claude Sonnet 4.6 was used during testing and was reliable for Review Assistant agent workflows.

Streaming is always enabled and is not configurable.

## Evaluation judge settings

For `npm run inference` and `npm run evaluation`, the repository `ground-truth/` folder is treated as `LOCAL_PATH` for app/project configs and local tools. Inference and evaluation artifacts still read from and write to the blob storage configured in `ground-truth/config/.env` via `INFERENCE_CONTAINER`.

`npm run evaluation` uses the Python evaluator and the native GitHub Copilot Python SDK to extract comparable facts and score material equivalence. Set Copilot authentication and optional model settings in `ground-truth/config/.env` or the shell before running evaluation:

```bash
COPILOT_GITHUB_TOKEN=<token>
AGENT_MODEL=gpt-5.5
REASONING_EFFORT=medium
```

`AGENT_MODEL` and `REASONING_EFFORT` are optional and use the same validation as app agent settings. `EVALUATION_JUDGE_TIMEOUT_SECONDS` defaults to `120`.

Ground truth records can declare evaluation settings under `evaluation`. `answer_path` identifies the answer field used by generation metrics. `evidence_path` and `evidence_key` identify the evidence collection and evidence field used for retrieval matching, such as `url`; when `evidence_key` is omitted, the evaluator does not compute `retrieval_recall`. Inference artifacts include the project's `config/schema.json` as the expected output shape; `evaluation.output_schema` is only needed when a case must override that schema. The evaluator reports this as `output_structure`, a schema-validity metric that checks required fields, types, item shape, and unexpected properties without comparing answer text or evidence content. Cases may declare `evaluation.ignored_output_structure_issues` as exact `{ "path", "keyword", "message" }` issue entries to suppress known-valid schema exceptions while keeping all other schema violations active.

## Evaluation catalog metrics

`npm run evaluation` derives inference timing metrics from each inference artifact and includes them in the evaluation output:

```json
{
  "meta_total_elapsed_ms": 12450,
  "meta_assistant_request_elapsed_ms": 9800,
  "meta_first_token_latency_ms": 1700,
  "meta_stream_elapsed_ms": 8100,
  "meta_tool_elapsed_ms": 2100,
  "meta_unattributed_elapsed_ms": 2650
}
```

`meta_assistant_request_elapsed_ms` measures the full agent request, `meta_first_token_latency_ms` measures request start to first streamed response chunk, `meta_stream_elapsed_ms` measures first chunk to completion, and `meta_unattributed_elapsed_ms` measures case time outside assistant requests. Tool time is reported separately and can overlap the assistant request window.

The evaluator reads catalog settings from `ground-truth/config/.env` or the shell. Set all three to enable unauthenticated metric publishing:

```bash
EXPERIMENT_CATALOG_URL=https://eval-catalog.salmonsky-371093b3.eastus2.azurecontainerapps.io/
EXPERIMENT_CATALOG_PROJECT=review-assistant
EXPERIMENT_CATALOG_EXPERIMENT=baseline
```

If `EXPERIMENT_CATALOG_URL` is unset, evaluation still writes `.eval.json` outputs but does not push metrics to the catalog.

Catalog result sets are allocated from the inference run folder. The evaluator reads existing sets from the catalog and publishes each evaluation pass to the next `<run_folder>-A`, `<run_folder>-B`, `<run_folder>-C`, etc. set name.

## Example agent requests

You can ask the agent for focused tasks in plain language. Example prompts:

- Give me a schema based on these attached docs.
- I want to answer the question "xxx".
- Create me a new turn.
- Search for "yyy".

## Chat attachments

The renderer can request text attachments through the preload API, but main owns file dialogs and file reads. Renderer-visible attachment objects contain only `id`, `name`, `path`, and `sizeBytes`; file content stays in main until `chat:start` resolves the cached attachment IDs. Removing an attachment discards its main-process cache entry.

## External MCP connectors

Drop an `mcp.json` file next to the app `LOCAL_PATH/config/.env` to define MCP sources shared by all projects, or into a project's `config/` folder to define project-specific sources. The file uses the standard `mcpServers` shape:

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

`${NAME}` placeholders resolve from the project/app `config/.env` or process environment at chat start, so customers can use different sources and auth without changing application code. Secret-like values are redacted from renderer-visible project configuration and logs. Omit `allowedTools` to allow all tools exposed by that MCP server.

For each chat request, Review Assistant merges app-level and selected project-level MCP servers, then registers the merged set with the spawned Copilot process through a temporary MCP config. If app and project files define the same server id, the project-level definition overrides the app-level definition for that request.

## Engineering docs

- `docs/ARCHITECTURE.md` documents process boundaries, storage ownership, local tools, and refactor rules.
- `docs/OBSERVABILITY.md` documents stable `review-assistant.*` event names and logging fields.
- `AGENTS.md` documents agent operating rules and deterministic harness commands.
- `PLANS.md` records product/release planning notes.
