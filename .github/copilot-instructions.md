# Copilot Instructions

## Testing and handoff requirements

- Add or update behavior-focused tests for every functional change. Prefer tests that exercise public boundaries: storage adapters, IPC/preload contracts, renderer behavior, and real Electron flows.
- Do not rely on manual testing as the only proof for app behavior. If a bug reaches the user, add a regression test or smoke assertion that would have caught it.
- Before handing work back, run the smallest deterministic gate that covers the changed surface:
  - Core logic or storage: `npm run test:unit` and/or `npm run test:integration`.
  - Renderer behavior: `npm run test:ui`.
  - IPC, preload, main process, launch, or cross-process behavior: `npm run test:e2e` and `npm run smoke`.
  - Any TypeScript or script change: `npm run lint` and `npm run typecheck`.
- For broad changes, run `npm run check`.
- If a verification command cannot be run, explicitly say why and what remains unverified.

## Architecture guardrails

- Keep the renderer UI-only. Do not add filesystem, Azure, child-process, or Electron main-process access to renderer code.
- Expose renderer capabilities only through the typed preload API and allowlisted IPC channels.
- When adding a preload `ipcRenderer.invoke(...)` channel, add the matching `ipcMain.handle(...)` registration and ensure `npm run smoke` covers the channel pairing.
- Keep storage backends behind `StorageAdapter`; do not leak local filesystem or Azure Blob details into renderer code.

## UI conventions

- Use compact icon action buttons for common create, refresh, clear, delete, save, attach, cancel, and similar toolbar/modal actions: `action-icon-button` plus semantic color classes (`create-project-button` for positive create/save, `secondary-button` for neutral actions, `danger-button` for destructive actions). Include an accessible `aria-label`, `data-tooltip`, and an `aria-hidden` icon glyph so action size, color, and tooltip behavior match the rest of the app.
