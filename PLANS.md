# Plans

## v0.1.0 baseline

The app is a TypeScript Electron desktop application with React renderer, secure preload bridge, main-process storage orchestration, local/Azure backend adapters, Ajv-backed schema validation, and deterministic harness scripts. The first release focuses on read-only project review and non-persistent local-agent chat.

## Current engineering baseline

Review Assistant now supports schema-driven review records, draft-backed edits, configurable feedback, GitHub Copilot chat, local Review Assistant tools, generated schema saves, search-result saves, conversation-turn tools, text attachment context, and app/project external MCP connectors.

Engineering work should keep these surfaces aligned:

- Documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/OBSERVABILITY.md`, `AGENTS.md`, and this file.
- Harness: `make smoke`, `make check`, `make test`, `make ci`, and `make audit-harness`.
- Coverage: schema validation/rendering, storage adapters, local tools, preload/main IPC, renderer behavior, and real Electron smoke/e2e flows.
- Schema variability: every schema-dependent feature should include a test using a non-sample schema shape.
