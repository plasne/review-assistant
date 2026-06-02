<!-- markdownlint-disable-file -->
# Research: `_display.json` Field Presentation Configuration

Research for implementing a project-level `_display.json` file that maps JSON Pointer-like paths, including the existing `*` array-item wildcard, to field presentation hints such as `chat-user` and `chat-assistant`. This updates the prior recommendation in `.copilot-tracking/research/2026-06-02/schema-specific-field-ux-research.md` based on the user's decision to use `_display.json`.

## Index

| Section | Summary |
|---|---|
| Prior-research verification | Confirms prior findings and adds exact line ranges for storage helpers |
| Why `_display.json` | Decouples display from schema, supports generated/shared schemas, mirrors `_feedback.json` |
| File shape | Top-level `fields` map with JSON Pointer-like keys and `*` array wildcard |
| Normalization | Tolerant `normalizeDisplayConfig` mirrors `normalizeFeedbackConfig` |
| Path convention | Reuse `feedbackTargetMatchesPath` for exact and wildcard matching |
| Storage | Internal read during `getRecord`; no `StorageAdapter` method required for MVP |
| IPC/preload | No new channel; display hints are baked into `RenderNode.presentation` |
| Renderer | Optional `presentation` dispatch branch before enum/generic output |
| Tests | Unit, integration, UI, and optional E2E coverage |

## Prior-Research Verification

| Claim | Verified at |
|---|---|
| `RenderNode` value kind has no `presentation` field today | `src/shared/types.ts:51-60` |
| `buildRenderTree` takes `schema`, `data`, `issues`, optional `label` | `src/main/schema.ts:20-26` |
| `renderSchema` attaches `description` and `enum` but no other hints | `src/main/schema.ts:35-81` |
| `buildRecordDetail` calls `buildRenderTree(schema, coreData, issues)` | `src/main/storage.ts:440-453` |
| `LocalStorageAdapter.getRecord` reads `_schema.json` then calls `buildRecordDetail` | `src/main/storage.ts:102-109` |
| `AzureBlobStorageAdapter.getRecord` follows the same pattern | `src/main/storage.ts:247-253` |
| `readOptionalJsonFile` exists for optional local config files | `src/main/storage.ts:385-394` |
| Optional Azure blob helper exists | `src/main/storage.ts:342-349` |
| `_feedback.json` is read through a private helper | `src/main/storage.ts:186-189` |
| `normalizeFeedbackConfig` is the closest normalization precedent | `src/shared/feedback.ts:80-96` |
| `ARRAY_ITEM_PATH_SEGMENT = '*'` wildcard convention exists | `src/shared/feedback.ts:17` |
| `feedbackTargetMatchesPath` is exported and reusable | `src/shared/feedback.ts:101-109` |
| `_`-prefixed files are already excluded from record listing | `src/main/storage.ts:363` |
| `assertRecordDetail` casts broadly, so additive optional fields flow through | `src/shared/validators.ts:100-108` |
| Renderer value dispatch is currently enum-or-output | `src/renderer/main.tsx:1053` |
| Existing user/assistant chat colors are available as visual precedent | `src/renderer/styles.css:534-539` |
| No `_display.json` exists today | Confirmed by subagent codebase search |

New detail: `buildRecordDetail` is a module-private helper at `src/main/storage.ts:440-453`. Both local and Azure adapters call it, so threading display config through this helper updates both backends with one shared render-tree path.

## Why `_display.json` Over `x-presentation`

The prior research selected `x-presentation`; the user has selected `_display.json`. The evidence-supported reason to prefer `_display.json` is that presentation policy stays decoupled from the JSON Schema. This matters when schemas are generated, shared across projects, owned by another system, or intended to remain a pure data contract.

| Dimension | `x-presentation` | `_display.json` |
|---|---|---|
| Requires schema edits | Yes | No |
| Works with generated/shared schemas | Weak | Strong |
| Separation of concerns | Mixes schema and display | Keeps display as project config |
| Existing project-file precedent | New vendor keyword pattern | Mirrors `_feedback.json` |
| New IPC needed | No | No |
| Renderer stays UI-only | Yes | Yes |

## Recommended File Shape

```json
{
  "fields": {
    "/turns/*/request": {
      "presentation": "chat-user"
    },
    "/turns/*/response": {
      "presentation": "chat-assistant"
    }
  }
}
```

Design decisions:

* Use top-level `fields`, not `properties`, to avoid confusion with JSON Schema.
* Keys are absolute JSON Pointer paths that begin with `/`.
* `*` remains the project convention for "any array index", matching `_feedback.json`.
* The file is optional; absence normalizes to `{ "fields": {} }`.
* Do not create `_display.json` in `createProject`; users add it only when custom presentation is needed.

## Types and Normalization

Add shared types in `src/shared/types.ts`:

```typescript
export const FIELD_PRESENTATIONS = ['chat-user', 'chat-assistant'] as const;
export type FieldPresentation = (typeof FIELD_PRESENTATIONS)[number];

export type DisplayConfigEntry = {
  presentation: FieldPresentation;
};

export type DisplayConfig = {
  fields: Record<string, DisplayConfigEntry>;
};
```

Add optional presentation to value `RenderNode`:

```typescript
| {
    kind: 'value';
    label: string;
    path?: string;
    description?: string;
    presentation?: FieldPresentation;
    value: unknown;
    type?: string;
    enumValues?: unknown[];
    validationIssues: ValidationIssue[];
  }
```

Create `src/shared/display.ts`:

```typescript
import { feedbackTargetMatchesPath } from './feedback';
import {
  FIELD_PRESENTATIONS,
  type DisplayConfig,
  type DisplayConfigEntry,
  type FieldPresentation
} from './types';

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeDisplayConfig = (config: unknown): DisplayConfig => {
  const raw = isPlainRecord(config) && isPlainRecord(config.fields) ? config.fields : {};
  const fields: Record<string, DisplayConfigEntry> = {};

  for (const [path, entry] of Object.entries(raw)) {
    if (!isPlainRecord(entry) || !path.startsWith('/')) {
      continue;
    }

    if (!FIELD_PRESENTATIONS.includes(entry.presentation as FieldPresentation)) {
      continue;
    }

    fields[path] = { presentation: entry.presentation as FieldPresentation };
  }

  return { fields };
};

export const displayConfigEntryForPath = (
  config: DisplayConfig,
  path: string
): DisplayConfigEntry | undefined =>
  config.fields[path] ??
  Object.entries(config.fields).find(([target]) => feedbackTargetMatchesPath(target, path))?.[1];
```

The tolerant normalization behavior should match `normalizeFeedbackConfig`: invalid entries are ignored, while malformed JSON still propagates as a read error.

## Storage Design

No new `StorageAdapter` interface method is required for the MVP because the display config is consumed entirely inside `getRecord` and baked into `RecordDetail.renderTree`.

Local adapter addition:

```typescript
private async readDisplayConfig(project: string): Promise<DisplayConfig> {
  const raw = await readOptionalJsonFile(path.join(project, '_display.json'));
  return normalizeDisplayConfig(raw);
}
```

Update `LocalStorageAdapter.getRecord` at `src/main/storage.ts:102-109` to read display config and pass it to `buildRecordDetail`.

Update `AzureBlobStorageAdapter.getRecord` at `src/main/storage.ts:247-253` to read optional `_display.json`, normalize it, and pass it to `buildRecordDetail`.

Update `buildRecordDetail` at `src/main/storage.ts:440-453`:

```typescript
const buildRecordDetail = (
  projectId: string,
  recordId: string,
  schema: unknown,
  data: unknown,
  displayConfig?: DisplayConfig
): RecordDetail => {
  const coreData = stripFeedbackProperties(data);
  const validationIssues = validateRecord(schema, coreData);
  return {
    projectId,
    recordId,
    displayName: recordId,
    data: coreData,
    schema,
    validationIssues,
    renderTree: buildRenderTree(schema, coreData, validationIssues, 'record', displayConfig),
    feedbackHistory: extractFeedbackHistory(data, deriveFeedbackTargets(schema))
  };
};
```

## Render-Tree and Renderer Design

Update `src/main/schema.ts:20-81` so `buildRenderTree` and recursive `renderSchema` accept optional `DisplayConfig`, forward it through recursive object/array calls, and attach a matching `presentation` value to value nodes:

```typescript
presentation: displayConfig && path
  ? displayConfigEntryForPath(displayConfig, path)?.presentation
  : undefined
```

Update renderer dispatch at `src/renderer/main.tsx:1053`:

```tsx
{node.presentation === 'chat-user' || node.presentation === 'chat-assistant'
  ? (
    <output className={`field-chat-bubble field-chat-bubble--${node.presentation}`}>
      {formatValue(node.value)}
    </output>
  )
  : node.enumValues
  ? <EnumValue node={node} />
  : <output>{formatValue(node.value)}</output>}
```

Dispatch priority should be `presentation` first, then enum rendering, then generic output. A display config entry is a deliberate presentation override.

Recommended CSS, reusing the visual language around `src/renderer/styles.css:534-539`:

```css
.field-chat-bubble {
  border-radius: 0.75rem;
  display: block;
  max-width: 85%;
  padding: 0.5rem 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.field-chat-bubble--chat-user {
  background: #163a5c;
  margin-left: auto;
}

.field-chat-bubble--chat-assistant {
  background: #1d4630;
  margin-right: auto;
}
```

## Sample Config

Create `data/local-project/_display.json`:

```json
{
  "fields": {
    "/turns/*/request": {
      "presentation": "chat-user"
    },
    "/turns/*/response": {
      "presentation": "chat-assistant"
    }
  }
}
```

Create `test-fixtures/local-projects/sample-project/_display.json`:

```json
{
  "fields": {
    "/question": {
      "presentation": "chat-user"
    },
    "/answer": {
      "presentation": "chat-assistant"
    }
  }
}
```

## Test Plan

* `tests/unit/display.test.ts`
  * Assert missing config normalizes to `{ fields: {} }`.
  * Assert valid `chat-user` and `chat-assistant` entries are retained.
  * Assert unknown presentation values, non-slash keys, and non-object entries are dropped.
  * Assert `displayConfigEntryForPath` handles exact and `*` wildcard paths.
* `tests/unit/schema.test.ts`
  * Assert `buildRenderTree(..., displayConfig)` attaches `presentation` to matching value nodes.
  * Assert nodes have no presentation when display config is absent.
* `tests/integration/local-storage.test.ts`
  * Assert `LocalStorageAdapter.getRecord` applies fixture `_display.json` hints to the returned render tree.
* `tests/ui/app.test.tsx`
  * Assert `chat-user` and `chat-assistant` nodes render with bubble classes.
  * Assert generic nodes remain generic.
* Optional `tests/e2e/electron.spec.ts`
  * Assert one rendered record field has the expected bubble class in a live Electron flow.

## Touch-Point Summary

| File | Action |
|---|---|
| `src/shared/types.ts` | Add `FieldPresentation`, `DisplayConfigEntry`, `DisplayConfig`; add `presentation?` to value `RenderNode` |
| `src/shared/display.ts` | New normalization and path lookup helpers |
| `src/main/schema.ts` | Accept optional display config and attach matching presentation hints |
| `src/main/storage.ts` | Read optional `_display.json` for local and Azure records; pass config to shared `buildRecordDetail` |
| `src/renderer/main.tsx` | Dispatch presented value nodes to chat-bubble output |
| `src/renderer/styles.css` | Add field chat-bubble CSS classes |
| `data/local-project/_display.json` | New sample display config |
| `test-fixtures/local-projects/sample-project/_display.json` | New fixture display config |
| `tests/unit/display.test.ts` | New unit tests |
| `tests/unit/schema.test.ts` | Extend render-tree tests |
| `tests/integration/local-storage.test.ts` | Extend storage integration tests |
| `tests/ui/app.test.tsx` | Extend renderer tests |

## Verification Gates

After implementation:

```text
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:ui
npm run smoke
```

Run `npm run test:e2e` too if the implementation adds or changes an E2E assertion.

## Research Summary

| Item | Detail |
|---|---|
| Approach | Project-level `_display.json` with JSON Pointer-like path keys and `*` array wildcard |
| IPC changes | None |
| New types | `FieldPresentation`, `DisplayConfigEntry`, `DisplayConfig`; `presentation?` on value nodes |
| New shared module | `src/shared/display.ts` |
| Precedent | Mirrors `_feedback.json`, `normalizeFeedbackConfig`, and `feedbackTargetMatchesPath` |
| Validation | Tolerant normalization at read time |
| Renderer contract | `presentation` branch before enum and generic output |
| Test surface | Unit, integration, UI, and optional E2E |
