import type {
  CanonicalMapping,
  FeedbackConfig,
  FeedbackEditMode,
  FeedbackConfigEntry,
  FeedbackEntry,
  FeedbackHistory,
  FieldPresentation,
  FeedbackMode,
  FeedbackSubmissionInput,
  FeedbackTarget,
  ProjectUser
} from './types';

export const FEEDBACK_MODES: FeedbackMode[] = ['none', 'good_fair_bad', 'thumbs', 'stars_5'];
export const FEEDBACK_EDIT_MODES: FeedbackEditMode[] = ['none', 'logged', 'inline'];
export const FIELD_PRESENTATIONS: FieldPresentation[] = ['chat-request', 'chat-response', 'evidence-list', 'tags'];
export const CANONICAL_MAPPINGS: CanonicalMapping[] = ['turns', 'request', 'response', 'evidence', 'facts', 'tags'];
export const USERNAME_VALIDATION_MESSAGE = 'USERNAME environment variable not configured. Please set USERNAME in your .env file.';

const FEEDBACK_SUFFIXES = ['_feedback', '_edits', '_comments'];
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{1,254}$/;
const ARRAY_ITEM_PATH_SEGMENT = '*';

type JsonSchema = Record<string, unknown>;
type FeedbackRecord = {
  original?: string;
  feedback?: string;
  comment?: string;
  edit?: string;
  username?: string;
  timestamp?: string;
};

export const getProjectUser = (values: Record<string, string>): ProjectUser => {
  const username = values.USERNAME?.trim() ?? '';
  if (!username || !USERNAME_PATTERN.test(username)) {
    return { valid: false, validationMessage: USERNAME_VALIDATION_MESSAGE };
  }
  return { username, valid: true };
};

export const assertValidUsername = (username: string | undefined): string => {
  const result = getProjectUser({ USERNAME: username ?? '' });
  if (!result.valid || !result.username) {
    throw new Error(USERNAME_VALIDATION_MESSAGE);
  }
  return result.username;
};

export const assertFeedbackSubmissionInput = (input: FeedbackSubmissionInput): FeedbackSubmissionInput => {
  const values = [input.feedbackValue, input.commentValue, input.editValue]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new Error('Feedback submission must include a non-empty feedback value, comment, or edit.');
  }
  return {
    propertyPath: input.propertyPath,
    feedbackValue: input.feedbackValue?.trim(),
    commentValue: input.commentValue?.trim(),
    editValue: input.editValue?.trim()
  };
};

export const createFeedbackEntry = (value: string, username: string, date = new Date()): FeedbackEntry => {
  const timestamp = date.toISOString();
  if (!timestamp.endsWith('Z') || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('Feedback timestamp must be a valid ISO 8601 UTC value.');
  }
  return { value, username: assertValidUsername(username), timestamp };
};

export const deriveFeedbackTargets = (schema: unknown): FeedbackTarget[] => {
  if (!isSchema(schema)) {
    return [];
  }
  const properties = isSchemaMap(schema.properties) ? schema.properties : {};
  const targets: FeedbackTarget[] = [];
  for (const [name, propertySchema] of Object.entries(properties)) {
    collectTarget(name, propertySchema, [name], targets, 'Main');
  }
  return targets;
};

export const normalizeFeedbackConfig = (schema: unknown, config: unknown): FeedbackConfig => {
  const existing = readConfigEntries(config);
  const assignedMappings = new Set<CanonicalMapping>();
  const properties: Record<string, FeedbackConfigEntry> = {};
  const targets = deriveFeedbackTargets(schema);
  for (const target of targets) {
    const current = existing[target.path];
    const mapping =
      current?.mapping && supportsCanonicalMapping(target) && !assignedMappings.has(current.mapping) ? current.mapping : undefined;
    if (mapping) {
      assignedMappings.add(mapping);
    }
    const supportsEditMode = target.editMode !== undefined || isCanonicalStringArrayTarget(target, targets, mapping);
    const entry: FeedbackConfigEntry = {
      path: target.path,
      target: target.target,
      tab: current?.tab && current.tab.trim() ? current.tab : target.tab,
      feedback: current && FEEDBACK_MODES.includes(current.feedback) ? current.feedback : 'none',
      comments: current?.comments === true,
      ...(current?.presentation ? { presentation: current.presentation } : {}),
      ...(mapping ? { mapping } : {}),
      ...(supportsEditMode ? { editMode: current && FEEDBACK_EDIT_MODES.includes(current.editMode ?? 'none') ? (current.editMode ?? 'none') : 'none' } : {})
    };
    properties[target.path] = entry;
  }
  return { properties };
};

export const feedbackConfigEntryForPath = (config: FeedbackConfig, propertyPath: string): FeedbackConfigEntry | undefined =>
  config.properties[propertyPath] ?? Object.values(config.properties).find((entry) => feedbackTargetMatchesPath(entry.path, propertyPath));

export const feedbackTargetMatchesPath = (targetPath: string, propertyPath: string): boolean => {
  const targetSegments = targetPath.split('/').filter(Boolean);
  const propertySegments = propertyPath.split('/').filter(Boolean);
  return (
    targetSegments.length === propertySegments.length &&
    targetSegments.every(
      (segment, index) => segment === propertySegments[index] || (segment === ARRAY_ITEM_PATH_SEGMENT && /^\d+$/.test(propertySegments[index] ?? ''))
    )
  );
};

export const toPersistedFeedbackConfig = (config: FeedbackConfig): unknown => ({
  properties: Object.fromEntries(
    Object.entries(config.properties).map(([path, entry]) => [
      path,
      {
        path: entry.path,
        target: entry.target,
        tab: entry.tab,
        feedback: entry.feedback,
        comments: entry.comments,
        ...(entry.presentation ? { presentation: entry.presentation } : {}),
        ...(entry.mapping ? { mapping: entry.mapping } : {}),
        ...(entry.editMode !== undefined ? { edit_mode: entry.editMode } : {})
      }
    ])
  )
});

export const feedbackPropertyBase = (propertyPath: string): string => {
  const parts = propertyPath.split('/').filter(Boolean).map(unescapePointer);
  if (parts.length === 0 || parts.some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    throw new Error('Invalid feedback property path.');
  }
  return parts.map((part) => part.replace(/[^a-zA-Z0-9-]/g, '_')).join('__');
};

export const feedbackPropertyNames = (propertyPath: string): { feedback: string; edits: string; comments: string } => {
  const base = feedbackPropertyBase(propertyPath);
  return {
    feedback: `${base}_feedback`,
    edits: `${base}_edits`,
    comments: `${base}_comments`
  };
};

export const feedbackPropertyName = (propertyPath: string): string => `${feedbackPropertyBase(propertyPath)}_feedback`;

export const stripFeedbackProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripFeedbackProperties);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isFeedbackPropertyName(key))
      .map(([key, entryValue]) => [key, stripFeedbackProperties(entryValue)])
  );
};

export const extractFeedbackHistory = (record: unknown, targets: FeedbackTarget[]): Record<string, FeedbackHistory> => {
  if (!isPlainRecord(record)) {
    return {};
  }
  const history: Record<string, FeedbackHistory> = {};
  for (const target of targets) {
    if (target.path.split('/').includes(ARRAY_ITEM_PATH_SEGMENT)) {
      collectWildcardFeedbackHistory(record, target.path, history);
    } else {
      history[target.path] = readFeedbackHistory(record, target.path);
    }
  }
  return history;
};

export const mergeFeedbackEntries = (
  record: Record<string, unknown>,
  input: FeedbackSubmissionInput,
  username: string,
  date = new Date()
): FeedbackEntry[] => {
  const names = feedbackPropertyNames(input.propertyPath);
  const timestamp = date.toISOString();
  if (!timestamp.endsWith('Z') || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('Feedback timestamp must be a valid ISO 8601 UTC value.');
  }
  const feedback = input.feedbackValue?.trim();
  const comment = input.commentValue?.trim();
  const edit = input.editValue?.trim();
  const validUsername = assertValidUsername(username);
  const entry: FeedbackRecord = {
    ...(feedback ? { feedback } : {}),
    ...(comment ? { comment } : {}),
    ...(edit ? { edit } : {}),
    username: validUsername,
    timestamp
  };
  const existingRecords = readFeedbackRecordsForStorage(record[names.feedback]);
  const current = existingRecords.length > 0 ? existingRecords : feedbackHistoryToRecords(readFeedbackHistory(record, input.propertyPath));
  const currentValue = readPropertyValue(record, input.propertyPath);
  const original = readFeedbackOriginal(record[names.feedback]) ?? (edit ? formatStoredValue(currentValue) : undefined);
  record[names.feedback] = [...(original !== undefined ? [{ original }] : []), ...current, entry];
  if (edit) {
    writePropertyValue(record, input.propertyPath, coerceStoredEditValue(currentValue, edit));
  }
  delete record[names.comments];
  delete record[names.edits];
  return [
    ...(feedback ? [{ value: feedback, username: validUsername, timestamp }] : []),
    ...(comment ? [{ value: comment, username: validUsername, timestamp }] : []),
    ...(edit ? [{ value: edit, username: validUsername, timestamp }] : [])
  ];
};

export const isFeedbackPropertyName = (key: string): boolean => FEEDBACK_SUFFIXES.some((suffix) => key.endsWith(suffix));

const collectTarget = (label: string, schema: JsonSchema, segments: string[], targets: FeedbackTarget[], tab: string): void => {
  const path = feedbackTargetPath(segments);
  const resolved = resolveSchema(schema);
  const type = inferSchemaType(resolved);
  const scalarStringArray = type === 'array' && isScalarStringArraySchema(resolved);
  targets.push({ path, target: formatTarget(segments), tab, ...(type !== 'array' || scalarStringArray ? { editMode: 'none' as const } : {}) });
  if (type === 'array') {
    const itemSchema = isSchema(resolved.items) ? resolveSchema(resolved.items) : undefined;
    if (itemSchema && inferSchemaType(itemSchema) === 'object' && isSchemaMap(itemSchema.properties)) {
      const itemSegments = [...segments, ARRAY_ITEM_PATH_SEGMENT];
      targets.push({ path: feedbackTargetPath(itemSegments), target: formatTarget(itemSegments), tab: 'inherit' });
      for (const [childLabel, childSchema] of Object.entries(itemSchema.properties)) {
        collectTarget(childLabel, childSchema, [...itemSegments, childLabel], targets, 'inherit');
      }
    }
    return;
  }
  if (type !== 'object' || !isSchemaMap(resolved.properties)) {
    return;
  }
  for (const [childLabel, childSchema] of Object.entries(resolved.properties)) {
    collectTarget(childLabel, childSchema, [...segments, childLabel], targets, 'inherit');
  }
};

const feedbackTargetPath = (segments: string[]): string => `/${segments.map((segment) => (segment === ARRAY_ITEM_PATH_SEGMENT ? segment : escapePointer(segment))).join('/')}`;

const isScalarStringArraySchema = (schema: JsonSchema): boolean => {
  const itemSchema = isSchema(schema.items) ? resolveSchema(schema.items) : undefined;
  return itemSchema ? inferSchemaType(itemSchema) === 'string' : false;
};

const readConfigEntries = (config: unknown): Record<string, FeedbackConfigEntry> => {
  const properties = isPlainRecord(config) && isPlainRecord(config.properties) ? config.properties : {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, Record<string, unknown>] => isPlainRecord(entry[1]))
      .map(([path, entry]) => [
        path,
        {
          path,
          target: typeof entry.target === 'string' ? entry.target : path,
          tab: typeof entry.tab === 'string' ? entry.tab : 'inherit',
          feedback: FEEDBACK_MODES.includes(entry.feedback as FeedbackMode) ? (entry.feedback as FeedbackMode) : 'none',
          comments: entry.comments === true,
          ...(FIELD_PRESENTATIONS.includes(entry.presentation as FieldPresentation) ? { presentation: entry.presentation as FieldPresentation } : {}),
          ...(CANONICAL_MAPPINGS.includes(entry.mapping as CanonicalMapping) ? { mapping: entry.mapping as CanonicalMapping } : {}),
          ...(FEEDBACK_EDIT_MODES.includes((entry.editMode ?? entry.edit_mode) as FeedbackEditMode)
            ? { editMode: (entry.editMode ?? entry.edit_mode) as FeedbackEditMode }
            : {})
        }
      ])
  );
};

const supportsCanonicalMapping = (target: FeedbackTarget): boolean => !target.target.endsWith(' > *');

const isCanonicalStringArrayTarget = (target: FeedbackTarget, targets: FeedbackTarget[], mapping: CanonicalMapping | undefined): boolean =>
  mapping === 'tags' && !targets.some((candidate) => candidate.path === `${target.path}/${ARRAY_ITEM_PATH_SEGMENT}`);

const collectWildcardFeedbackHistory = (record: Record<string, unknown>, targetPath: string, history: Record<string, FeedbackHistory>): void => {
  const targetSegments = targetPath.split('/').filter(Boolean);
  const basePattern = targetSegments
    .map((segment) => (segment === ARRAY_ITEM_PATH_SEGMENT ? '(\\d+)' : escapeRegExp(sanitizeFeedbackSegment(unescapePointer(segment)))))
    .join('__');
  const keyPattern = new RegExp(`^${basePattern}_(feedback|edits|comments)$`);
  for (const [key, value] of Object.entries(record)) {
    const match = keyPattern.exec(key);
    if (!match) {
      continue;
    }
    const wildcardValues = match.slice(1, -1);
    let wildcardIndex = 0;
    const propertyPath = `/${targetSegments
      .map((segment) => (segment === ARRAY_ITEM_PATH_SEGMENT ? wildcardValues[wildcardIndex++] : segment))
      .join('/')}`;
    const kind = match[match.length - 1] as 'feedback' | 'edits' | 'comments';
    if (kind === 'feedback') {
      history[propertyPath] = readFeedbackHistory(record, propertyPath);
    } else if (!history[propertyPath]) {
      history[propertyPath] = readFeedbackHistory(record, propertyPath);
    } else {
      history[propertyPath][kind] = readFeedbackEntries(value);
    }
  }
};

const readFeedbackHistory = (record: Record<string, unknown>, propertyPath: string): FeedbackHistory => {
  const names = feedbackPropertyNames(propertyPath);
  const unified = readFeedbackHistoryNode(record[names.feedback]);
  return {
    feedback: unified.feedback.length > 0 ? unified.feedback : readFeedbackEntries(record[names.feedback]),
    comments: unified.comments.length > 0 ? unified.comments : readFeedbackEntries(record[names.comments]),
    edits: unified.edits.length > 0 ? unified.edits : readFeedbackEntries(record[names.edits]),
    ...(unified.original !== undefined ? { original: unified.original } : {})
  };
};

const readFeedbackHistoryNode = (value: unknown): FeedbackHistory => {
  const records = readFeedbackRecords(value);
  const original = readFeedbackOriginal(value);
  if (records.length > 0) {
    return {
      feedback: records.flatMap((record) => (record.feedback ? [{ value: record.feedback, username: record.username, timestamp: record.timestamp }] : [])),
      comments: records.flatMap((record) => (record.comment ? [{ value: record.comment, username: record.username, timestamp: record.timestamp }] : [])),
      edits: records.flatMap((record) => (record.edit ? [{ value: record.edit, username: record.username, timestamp: record.timestamp }] : [])),
      ...(original !== undefined ? { original } : {})
    };
  }
  if (!isPlainRecord(value)) {
    return { feedback: [], comments: [], edits: [] };
  }
  return {
    feedback: readFeedbackEntries(value.feedback),
    comments: readFeedbackEntries(value.comments),
    edits: readFeedbackEntries(value.edits),
    ...(typeof value.original === 'string' ? { original: value.original } : {})
  };
};

const readFeedbackRecords = (value: unknown): Array<FeedbackRecord & { username: string; timestamp: string }> => {
  return parseFeedbackRecords(value).sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
};

const readFeedbackRecordsForStorage = (value: unknown): Array<FeedbackRecord & { username: string; timestamp: string }> =>
  parseFeedbackRecords(value).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

const parseFeedbackRecords = (value: unknown): Array<FeedbackRecord & { username: string; timestamp: string }> => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainRecord)
    .flatMap((entry) => {
      const feedback = typeof entry.feedback === 'string' ? entry.feedback : undefined;
      const comment = typeof entry.comment === 'string' ? entry.comment : typeof entry.comments === 'string' ? entry.comments : undefined;
      const edit = typeof entry.edit === 'string' ? entry.edit : typeof entry.edits === 'string' ? entry.edits : undefined;
      return (feedback || comment || edit) && typeof entry.username === 'string' && typeof entry.timestamp === 'string'
        ? [{ ...(feedback ? { feedback } : {}), ...(comment ? { comment } : {}), ...(edit ? { edit } : {}), username: entry.username, timestamp: entry.timestamp }]
        : [];
    })
    .filter((entry) => entry.timestamp.endsWith('Z') && !Number.isNaN(Date.parse(entry.timestamp)))
};

const readFeedbackOriginal = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value.filter(isPlainRecord).find((entry) => typeof entry.original === 'string')?.original as string | undefined;
  }
  return isPlainRecord(value) && typeof value.original === 'string' ? value.original : undefined;
};

const feedbackHistoryToRecords = (history: FeedbackHistory): FeedbackRecord[] =>
  [
    ...history.feedback.map((entry) => ({ feedback: entry.value, username: entry.username, timestamp: entry.timestamp })),
    ...history.comments.map((entry) => ({ comment: entry.value, username: entry.username, timestamp: entry.timestamp })),
    ...history.edits.map((entry) => ({ edit: entry.value, username: entry.username, timestamp: entry.timestamp }))
  ].sort((left, right) => Date.parse(left.timestamp ?? '') - Date.parse(right.timestamp ?? ''));

const readFeedbackEntries = (value: unknown): FeedbackEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainRecord)
    .flatMap((entry) =>
      typeof entry.value === 'string' && typeof entry.username === 'string' && typeof entry.timestamp === 'string'
        ? [{ value: entry.value, username: entry.username, timestamp: entry.timestamp }]
        : []
    )
    .filter((entry) => entry.timestamp.endsWith('Z') && !Number.isNaN(Date.parse(entry.timestamp)))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
};

const readPropertyValue = (record: Record<string, unknown>, propertyPath: string): unknown => {
  let current: unknown = record;
  for (const segment of propertyPath.split('/').filter(Boolean).map(unescapePointer)) {
    if (!isPlainRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const writePropertyValue = (record: Record<string, unknown>, propertyPath: string, value: unknown): void => {
  const segments = propertyPath.split('/').filter(Boolean).map(unescapePointer);
  let current: unknown = record;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainRecord(current) && !Array.isArray(current)) {
      throw new Error('Feedback edit path does not exist in the record.');
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const leaf = segments[segments.length - 1];
  if (!leaf || (!isPlainRecord(current) && !Array.isArray(current))) {
    throw new Error('Feedback edit path does not exist in the record.');
  }
  (current as Record<string, unknown>)[leaf] = value;
};

const coerceStoredEditValue = (currentValue: unknown, edit: string): string | string[] =>
  Array.isArray(currentValue) && currentValue.every((item) => typeof item === 'string') ? parseStringArrayEditValue(edit) : edit;

const parseStringArrayEditValue = (value: string): string[] => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

const formatStoredValue = (value: unknown): string => {
  if (value === undefined) {
    return '(missing)';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const resolveSchema = (schema: JsonSchema): JsonSchema => {
  if (!Array.isArray(schema.allOf)) {
    return schema;
  }
  return schema.allOf.filter(isSchema).reduce<JsonSchema>((merged, current) => ({ ...merged, ...current }), { ...schema, allOf: undefined });
};

const inferSchemaType = (schema: JsonSchema): string | undefined => {
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  if (Array.isArray(schema.type) && typeof schema.type[0] === 'string') {
    return schema.type[0];
  }
  return isPlainRecord(schema.properties) ? 'object' : undefined;
};

const formatLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatTarget = (segments: string[]): string =>
  segments
    .filter((segment, index) => segment !== ARRAY_ITEM_PATH_SEGMENT || index === segments.length - 1)
    .map((segment) => (segment === ARRAY_ITEM_PATH_SEGMENT ? ARRAY_ITEM_PATH_SEGMENT : formatLabel(segment)))
    .join(' > ');

const sanitizeFeedbackSegment = (value: string): string => value.replace(/[^a-zA-Z0-9-]/g, '_');
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapePointer = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (value: string): string => value.replace(/~1/g, '/').replace(/~0/g, '~');

const isSchema = (value: unknown): value is JsonSchema => isPlainRecord(value);
const isSchemaMap = (value: unknown): value is Record<string, JsonSchema> => isPlainRecord(value) && Object.values(value).every(isSchema);
const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
