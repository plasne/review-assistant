import type { DisplayConfig, DisplayConfigEntry, FieldPresentation } from './types';

export const FIELD_PRESENTATIONS: FieldPresentation[] = ['chat-request', 'chat-response', 'evidence-list', 'diff-view'];

const ARRAY_ITEM_PATH_SEGMENT = '*';

export const normalizeDisplayConfig = (config: unknown): DisplayConfig => {
  const properties: Record<string, DisplayConfigEntry> = {};
  if (!isPlainRecord(config) || !isPlainRecord(config.properties)) {
    return { properties };
  }

  for (const [propertyPath, rawEntry] of Object.entries(config.properties)) {
    if (!isPlainRecord(rawEntry)) {
      continue;
    }
    const path = rawEntry.path === undefined ? propertyPath.trim() : typeof rawEntry.path === 'string' ? rawEntry.path.trim() : '';
    const presentation = rawEntry.presentation;
    if (!path || !isFieldPresentation(presentation)) {
      continue;
    }
    properties[path] = { path, presentation };
  }

  return { properties };
};

export const displayConfigEntryForPath = (config: DisplayConfig, propertyPath: string): DisplayConfigEntry | undefined =>
  config.properties[propertyPath] ?? Object.values(config.properties).find((entry) => displayTargetMatchesPath(entry.path, propertyPath));

export const displayTargetMatchesPath = (targetPath: string, propertyPath: string): boolean => {
  const targetSegments = targetPath.split('/').filter(Boolean);
  const propertySegments = propertyPath.split('/').filter(Boolean);
  return (
    targetSegments.length === propertySegments.length &&
    targetSegments.every(
      (segment, index) => segment === propertySegments[index] || (segment === ARRAY_ITEM_PATH_SEGMENT && /^\d+$/.test(propertySegments[index] ?? ''))
    )
  );
};

const isFieldPresentation = (value: unknown): value is FieldPresentation =>
  typeof value === 'string' && FIELD_PRESENTATIONS.includes(value as FieldPresentation);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
