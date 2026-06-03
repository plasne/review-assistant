# review-assistant

Electron desktop app for reviewing inference result records inside isolated projects.

## Quick start

```bash
npm install
printf 'LOCAL_PATH=%s\n' "$PWD/test-fixtures/local-projects" > .env
npm run electron
```

## Configuration

The app reads its `.env` from the current working directory (override with `REVIEW_ASSISTANT_APP_ENV`).

| Variable | Default | Description |
| --- | --- | --- |
| `LOCAL_PATH` | – | Local projects directory (selects the local storage backend). |
| `AZURE_STORAGE_ACCOUNT_NAME` / `AZURE_STORAGE_ACCOUNT_CONNSTRING` | – | Selects an Azure Blob storage backend. |
| `AUTO_OPEN_FIRST` | `true` | When enabled, the app automatically opens the first project and its first record (question) on launch. Set to `false`/`0`/`off` to start on the empty project picker. |

## Harness

Run all release gates with:

```bash
npm run check
```

Individual gates are `lint`, `typecheck`, `test:unit`, `test:integration`, `test:ui`, `test:e2e`, and `smoke`.

## Agent prompts

Place `_prompt.md` next to the app `.env` to define the default agent instructions. A project can provide its own `_prompt.md`; when present, the project prompt fully overrides the app prompt for chat requests in that project.

The generated request still appends the current project, selected record, local Review Assistant tools, plugins, and external MCP server metadata after the selected prompt.

## External MCP connectors

Drop an `_mcp.json` file next to the app `.env` to define MCP sources shared by all projects, or into a project to define project-specific sources. The file uses the standard `mcpServers` shape and can contain as many servers as needed:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
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
