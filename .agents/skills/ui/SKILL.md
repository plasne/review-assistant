---
name: ui
description: Configure Review Assistant schema-driven UI presentation with project _display.json files and renderer-safe presentation rules.
---

# UI

Goal: Configure schema-driven Review Assistant UI behavior with a project `_display.json` file.

Success means:
  - The project data folder contains `_display.json` with normalized `properties` entries.
  - Each configured path uses JSON Pointer-style slash paths and `*` for numeric array item segments.
  - Each presentation value is one of `chat-request`, `chat-response`, `evidence-list`, or `diff-view`.
  - Renderer behavior stays driven by display metadata instead of hard-coded field names.

Stop when: The target project renders the intended schema nodes with the configured presentations and the smallest matching UI test covers the behavior.

## `_display.json` pattern

Place `_display.json` in the project data folder beside the record JSON files.

Use this shape:

```json
{
  "properties": {
    "/turns/*/request": {
      "path": "/turns/*/request",
      "presentation": "chat-request"
    },
    "/turns/*/response": {
      "path": "/turns/*/response",
      "presentation": "chat-response"
    },
    "/turns/*/evidence": {
      "path": "/turns/*/evidence",
      "presentation": "evidence-list"
    },
    "/turns/*/evidence/*/content": {
      "path": "/turns/*/evidence/*/content",
      "presentation": "diff-view"
    }
  }
}
```

Use the object key as the path when `path` matches the key. Include the `path` property when you want entries to stay explicit and easy to copy.

Use `*` to match numeric array positions. The target `/turns/*/evidence/*/content` matches `/turns/0/evidence/2/content`.

## Presentations

| Presentation | Use for | UI behavior |
|---|---|---|
| `chat-request` | User prompt/message fields | Renders chat-style request content. |
| `chat-response` | Assistant response fields | Renders chat-style response content. |
| `evidence-list` | Evidence arrays | Renders evidence cards, enables the open-in-tab action, and pre-creates evidence tabs. |
| `diff-view` | Text fields with revisions | Renders content as a diff view, including editable feedback previews when feedback metadata enables editing. |

## Workflow

1. Identify the rendered schema path for the field.
2. Add or update the matching `properties` entry in the project `_display.json`.
3. Use a specific path for a single field or `*` segments for repeated array items.
4. Run `npm run test:unit` when display matching changes.
5. Run `npm run test:ui` when renderer behavior changes.
