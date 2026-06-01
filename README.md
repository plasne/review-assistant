# review-assistant

Electron desktop app for reviewing inference result records inside isolated projects.

## Quick start

```bash
npm install
printf 'LOCAL_PATH=%s\n' "$PWD/test-fixtures/local-projects" > .env
npm run electron
```

## Harness

Run all release gates with:

```bash
npm run check
```

Individual gates are `lint`, `typecheck`, `test:unit`, `test:integration`, `test:ui`, `test:e2e`, and `smoke`.
