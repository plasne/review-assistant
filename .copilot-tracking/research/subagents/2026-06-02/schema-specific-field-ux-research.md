<!-- markdownlint-disable-file -->
# Schema-Specific Field UX Research

**Date:** 2026-06-02
**Scope:** How Review Assistant currently renders schema-agnostic data fields and where semantic-field UX enhancements, such as iMessage-style chat bubbles for request/response fields, should be implemented.

## Evidence Log / Search Terms Used

| Search / Read | File | Purpose |
|---|---|---|
| `view src/shared/types.ts` | `src/shared/types.ts` | Data/schema model definitions |
| `view src/main/schema.ts` | `src/main/schema.ts` | Schema-to-RenderNode pipeline |
| `view src/renderer/main.tsx` | `src/renderer/main.tsx` | Renderer components and field display |
| `view src/renderer/styles.css` | `src/renderer/styles.css` | CSS classes and visual structure |
| `view src/shared/feedback.ts` | `src/shared/feedback.ts` | Config extension precedent |
| `view src/shared/validators.ts` | `src/shared/validators.ts` | IPC boundary validation patterns |
| `view src/preload/preload.ts` | `src/preload/preload.ts` | IPC channels |
| `view src/main/storage.ts` | `src/main/storage.ts` | StorageAdapter contract |
| `view data/local-project/_schema.json` | `data/local-project/_schema.json` | Real project schema with turns/request/response |
| `view data/local-project/q01.json` | `data/local-project/q01.json` | Real record data |
| `view tests/ui/app.test.tsx` | `tests/ui/app.test.tsx` | Renderer test patterns |
| `view tests/unit/schema.test.ts` | `tests/unit/schema.test.ts` | Schema/render-tree unit tests |
| `view docs/ARCHITECTURE.md` | `docs/ARCHITECTURE.md` | Architecture boundary rules |
| `view requirements/v0.5.0.md` | `requirements/v0.5.0.md` | Latest requirements |

## Data and Schema Model Definitions

`src/shared/types.ts:34-68` defines `RenderNode` as the sole data contract between main and renderer for schema-driven field display:

```typescript
export type RenderNode =
  | { kind: 'object'; label: string; path?: string; description?: string; children: RenderNode[]; validationIssues: ValidationIssue[] }
  | { kind: 'array';  label: string; path?: string; description?: string; items: RenderNode[];    validationIssues: ValidationIssue[] }
  | { kind: 'value';  label: string; path?: string; description?: string; value: unknown; type?: string; enumValues?: unknown[]; validationIssues: ValidationIssue[] }
  | { kind: 'raw';    label: string; path?: string; description?: string; value: unknown; reason: string; validationIssues: ValidationIssue[] };
```

`src/shared/types.ts:79-88` defines `RecordDetail`. The renderer receives `schema` opaquely and consumes `renderTree` as the rendering contract. The renderer does not inspect JSON Schema directly.

`data/local-project/_schema.json:14-51` has a concrete `turns` array with `request`, `response`, and `evidence` fields. This is the current example where chat-bubble presentation would enhance readability.

## Schema-to-RenderNode Pipeline

`src/main/schema.ts` is the conversion point from JSON Schema plus record data into a generic `RenderNode` tree.

| Function | Lines | Role |
|---|---|---|
| `buildRenderTree(schema, data, issues, label)` | 20-26 | Public entry; delegates to `renderSchema` |
| `renderSchema(label, schema, data, issues, path)` | 35-81 | Recursive walker; dispatches on inferred type |
| `resolveRenderableSchema(schema)` | 83-88 | Flattens `allOf` |
| `inferType(schema, data)` | 101-115 | Determines `object`, `array`, or primitive |
| `hasComplexConstruct(schema)` | 98-99 | Falls back to `raw` for `oneOf`, `$ref`, and similar constructs |

At `src/main/schema.ts:37`, `description` is extracted from the schema and placed on `RenderNode`. At `src/main/schema.ts:78`, `enumValues` is extracted. No other schema metadata is forwarded today. The field label comes from the schema property key name at `src/main/schema.ts:46-47`. The JSON pointer path is built at the same point.

## Field Rendering Components

`src/renderer/main.tsx` contains the recursive field renderer.

| Component | Lines | Renders |
|---|---|---|
| `RecordDetails` | 857-891 | Validation summary plus `RenderTreeRoot` |
| `RenderTreeRoot` | 893-923 | Unwraps root object and renders children via `RenderTree` |
| `RenderTree` | 926-1031 | Core recursive renderer |
| `FieldHeading` | 1033-1039 | Label, description, and meta heading |
| `FeedbackPanel` | 1041-1155 | Feedback controls and history |
| `FeedbackValueInput` | 1157-1200 | Rating controls |
| `EditInput` | 1202-1215 | Textarea or enum select for editable fields |
| `EnumValue` | 1268-1292 | Read-only enum display |
| `formatValue` | 1301-1309 | Generic value formatting |

The primary hook point is the value-node branch at `src/renderer/main.tsx:1023-1030`:

```tsx
return (
  <section className="field">
    <FieldHeading label={node.label} description={node.description} />
    {issues}
    {node.enumValues ? <EnumValue node={node} /> : <output>{formatValue(node.value)}</output>}
    <FeedbackPanel ... />
  </section>
);
```

Today the only value-specific display variation is whether `enumValues` exists. Semantic UX must intercept at this value rendering branch or at an adjacent small presentation dispatcher.

Array items at `src/renderer/main.tsx:992-1010` are rendered as collapsed `<details>` blocks when array items are objects. This is how `turns[n]` currently appears, with the first child value used as a summary identifier.

## Schema Agnosticism

Schema agnosticism is preserved by these current design choices:

1. `RenderNode` carries display structure, not hard-coded business concepts.
2. `buildRenderTree` branches on JSON Schema type, enum, allOf, properties, and items; it does not inspect field names.
3. Feedback configuration is path-based, keyed by JSON Pointer-like paths such as `/turns/*/request`, not labels.
4. `StorageAdapter` remains schema-neutral; `src/main/storage.ts:102-109` gets a record and calls `buildRenderTree`.
5. Renderer owns presentation. `docs/ARCHITECTURE.md:40` states that renderer owns presentation, keyboard/mouse interactions, chat view state, and schema-driven read-only rendering.

## Existing Configuration and Metadata Precedents

`src/shared/feedback.ts:80-96` and `src/main/storage.ts:186-189` establish a per-project `_feedback.json` pattern:

- Project-level file derived from `_schema.json` structure.
- Keyed by JSON pointer path.
- Normalized on read, with defaults applied for missing paths.
- Exposed over allowlisted preload IPC channels.
- Validated at the preload boundary.

JSON Schema metadata forwarding is already established:

- `src/main/schema.ts:37` forwards `description` from schema to `RenderNode.description`.
- `src/main/schema.ts:78` forwards `enum` to `RenderNode.enumValues`.
- `src/renderer/main.tsx:1023-1030` uses `enumValues` to select a presentation component.

These precedents support adding a small optional presentation hint to `RenderNode` rather than hard-coding field names in the renderer.

## Alternatives Considered

### Name-based heuristics in renderer

Example:

```typescript
const chatUserLabels = /^(request|query|prompt|question)$/i;
const chatAssistantLabels = /^(response|answer|reply|output)$/i;
```

Advantages:

- No config or IPC changes.
- Works immediately for `data/local-project/_schema.json` because it uses `request` and `response`.

Limitations:

- Brittle when schemas use different names such as `user_message`, `bot_reply`, `input`, or `completion`.
- Can produce false positives for unrelated fields.
- Undercuts the schema-agnostic principle because presentation behavior depends on hard-coded field labels.

Fit: Poor as the primary approach.

### Configurable semantic field mappings with `_display.json`

Example:

```json
{
  "properties": {
    "/turns/*/request": { "presentation": "chat-user" },
    "/turns/*/response": { "presentation": "chat-assistant" }
  }
}
```

Advantages:

- Generalizes to any schema.
- Mirrors the `_feedback.json` path-keyed configuration precedent.
- Does not require modifying the JSON Schema.

Limitations:

- Requires new storage methods, IPC channels, preload API surface, validators, and likely UI for editing.
- Introduces config drift risk between `_schema.json` and `_display.json`.
- Larger first implementation than the concrete UX enhancement requires.

Fit: Good long-term override mechanism, but heavyweight for the initial implementation.

### Renderer-only presentation registry

Example:

```typescript
const presentationRegistry: Record<string, 'chat-user' | 'chat-assistant'> = {
  request: 'chat-user',
  query: 'chat-user',
  prompt: 'chat-user',
  response: 'chat-assistant',
  answer: 'chat-assistant'
};
```

Advantages:

- No IPC or storage change.
- Keeps presentation logic in renderer.

Limitations:

- Same label-coupling problem as name heuristics.
- Requires code changes for every new schema vocabulary.

Fit: Poor.

### JSON Schema vendor extension `x-presentation`

Example:

```json
{
  "request": {
    "type": "string",
    "description": "User request text",
    "x-presentation": "chat-user"
  },
  "response": {
    "type": "string",
    "description": "Assistant response text",
    "x-presentation": "chat-assistant"
  }
}
```

Advantages:

- Keeps semantic presentation intent colocated with the schema field definition.
- Mirrors existing `description` and `enum` metadata forwarding.
- Requires no new IPC channels.
- Additive and backward-compatible because the field is optional.
- Renderer still owns styling and component choice.

Limitations:

- Schema authors must be able to add vendor extensions.
- Values should be validated or constrained to avoid typos.
- Hints inside complex constructs that currently become `raw` nodes would not flow through without deeper schema support.

Fit: Excellent for the current app architecture and concrete request/response use case.

### Hybrid defaults plus configuration overrides

Advantages:

- Common names work automatically.
- Overrides can handle unusual schemas.

Limitations:

- Most complex option.
- Creates precedence rules between guessed names, schema annotations, and config overrides.
- Harder to explain and test as the first implementation.

Fit: Overkill for the initial enhancement.

## Recommended Approach

Use a JSON Schema vendor extension named `x-presentation`, forward it through `RenderNode.presentation`, and dispatch display in the renderer.

Recommended initial presentation values:

```typescript
export type FieldPresentation = 'chat-user' | 'chat-assistant';
```

Future-compatible values could include `markdown`, `code`, `url`, `timestamp`, or `conversation-thread`, but the first implementation should keep the union closed to catch typos and preserve a small, testable behavior surface.

Implementation touch points:

| File | Change |
|---|---|
| `src/shared/types.ts:34-68` | Add `FieldPresentation` and optional `presentation?: FieldPresentation` to value `RenderNode`; consider array later only if thread-level rendering is selected |
| `src/main/schema.ts:35-81` | Extract `x-presentation` from renderable schema and forward valid values |
| `src/renderer/main.tsx:1023-1030` | Add a value presentation dispatcher before the enum/plain-output fallback |
| `src/renderer/styles.css:528-619` | Reuse or adapt existing `.message.user` and `.message.assistant` visual language for bubbles |
| `data/local-project/_schema.json:14-51` | Annotate request and response with `x-presentation` values |
| `tests/unit/schema.test.ts:100-157` | Add coverage that schema metadata flows to `RenderNode` |
| `tests/ui/app.test.tsx:625-682` | Add renderer coverage for `chat-user` and `chat-assistant` value nodes |

Renderer sketch:

```tsx
function FieldValue({ node }: { node: Extract<RenderNode, { kind: 'value' }> }) {
  if (node.presentation === 'chat-user' || node.presentation === 'chat-assistant') {
    return (
      <output className={`field-chat-bubble field-chat-bubble--${node.presentation}`}>
        {formatValue(node.value)}
      </output>
    );
  }

  return node.enumValues ? <EnumValue node={node} /> : <output>{formatValue(node.value)}</output>;
}
```

Schema extraction sketch:

```typescript
const fieldPresentationValues = ['chat-user', 'chat-assistant'] as const;
type FieldPresentation = (typeof fieldPresentationValues)[number];

function readPresentation(schema: Record<string, unknown>): FieldPresentation | undefined {
  const value = schema['x-presentation'];
  return fieldPresentationValues.includes(value as FieldPresentation) ? (value as FieldPresentation) : undefined;
}
```

Recommended behavior for invalid values: ignore unknown `x-presentation` values and keep the existing generic rendering, or surface a validation issue if the app has a schema validation path for schema metadata. Do not silently invent a fallback presentation for unknown values.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Schema authors forget `x-presentation` | Low | Existing rendering remains unchanged |
| Typo in `x-presentation` | Low | Use a closed TypeScript union and extraction helper |
| Optional `RenderNode` field impacts IPC | Low | Additive field on existing `records:get` payload; no new channel |
| Complex schema constructs lose hints | Low | Document limitation; current complex constructs already become `raw` nodes |
| Bubble layout conflicts with feedback UI | Medium | Add UI tests covering feedback-enabled presented fields |

## Gaps and Recommended Next Research

1. Define exact bubble appearance: width, alignment, color token usage, wrapping, and markdown behavior.
2. Decide whether chat UX should be field-level only or whether array-level `turns` should become a conversation-thread presentation.
3. Decide whether future projects need `_display.json` overrides when schema files cannot be edited.
4. Add a smoke or e2e assertion if the feature crosses renderer/main data flow in a way not covered by unit and UI tests.

## Concise Index

| Item | Detail |
|---|---|
| Path | `.copilot-tracking/research/subagents/2026-06-02/schema-specific-field-ux-research.md` |
| Status | Completed from codebase investigation |
| Primary hook | `src/renderer/main.tsx:1023-1030` |
| Schema metadata hook | `src/main/schema.ts:35-81` |
| Recommended approach | `x-presentation` JSON Schema vendor extension forwarded through `RenderNode.presentation` |
| Main gap | Exact bubble visual spec and whether array-level thread rendering is desired |
