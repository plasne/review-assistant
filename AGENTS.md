# Agent Operating Notes

## Project Overview

- Project: Review Assistant
- Primary runtimes: TypeScript, Electron, React, Node.js
- Main entrypoints: `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/main.tsx`, `src/agent/agent-process.ts`

## Assumptions

- Assume every project is greenfield with no users. I strive for a single source of truth: this means no fallbacks, no legacy code support, just one clean stream of information flow.

## Harness Commands

Run from repository root:

| Goal                    | Command      |
| ----------------------- | ------------ |
| Fast sanity check       | `make smoke` |
| Static checks           | `make check` |
| Full test suite         | `make test`  |
| CI-equivalent local run | `make ci`    |

The underlying deterministic npm gates are:

- `npm run lint`
- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:ui`
- `npm run test:e2e`
- `npm run smoke`

## Constraints And Guardrails

- Prefer deterministic scripts over interactive/manual steps.
- Keep command names stable (`smoke`, `check`, `test`, `ci`).
- Update docs and scripts in the same change when workflow behavior changes.
- Add or update behavior-focused tests with every functional change. If a bug reaches a user, add a regression test or smoke assertion that would have caught it before handing the fix back.
- Avoid side effects outside the repo unless explicitly required.

## Architecture Boundaries

- Keep the renderer UI-only. Do not add filesystem, Azure, child-process, or Electron main-process access to renderer code.
- Expose renderer capabilities only through the typed preload API and allowlisted IPC channels.
- Main owns storage, config, validation, agent orchestration, and local tool execution.
- Agent worker owns provider transport and MCP/tool bridge details.
- Keep storage backends behind `StorageAdapter`; do not leak local filesystem or Azure Blob details into renderer code.
- Document boundary ownership in `docs/ARCHITECTURE.md`.

## UI Conventions

- Use compact icon action buttons for common create, refresh, clear, delete, save, attach, cancel, and similar toolbar/modal actions: `action-icon-button` plus semantic color classes (`create-project-button` for positive create/save, `secondary-button` for neutral actions, `danger-button` for destructive actions). Include an accessible `aria-label`, `data-tooltip`, and an `aria-hidden` icon glyph so action size, color, and tooltip behavior match the rest of the app.

## Project Configuration

- Project review settings live in `config/config.json`; do not add `_feedback.json` or `_display.json` code paths.
- Persist `config/config.json` keys in snake_case at the storage boundary, while TypeScript may use camelCase internally.
- Canonical mappings (`turns`, `request`, `response`, `evidence`, `facts`, `tags`) must be unique across explicit config entries.
- Tool names and descriptions should be action-oriented and describe behavior from metadata without relying on prompt-only guidance.

## Observability Expectations

- Emit stable `review-assistant.*` event names for major transitions.
- Include request/correlation identifiers such as `requestId` and `toolRequestId` on long-running chat/tool workflows.
- Log durations as `elapsedMs` or context-specific millisecond fields.
- Redact secrets and avoid logging full record payloads.
- Maintain field definitions in `docs/OBSERVABILITY.md`.

## Execution Plans

- For tasks expected to exceed about 30 minutes, create or update the session plan before coding.
- Track scope, constraints, milestones, and verification steps.
- Update status checkpoints during execution and after major decisions.

## Static Analysis And Quality Gates

- Run `make check` before `make test`.
- Run `make ci` before pushing large refactors.
- Treat lint/type failures as blocking.

## Entropy Management

- Remove stale scripts/docs quickly.
- Keep harness scripts, npm scripts, and CI workflows in sync.
- Run periodic harness audits with `make audit-harness`.
