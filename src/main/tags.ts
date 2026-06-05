import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { feedbackConfigEntryForPath } from '../shared/feedback';
import type { FeedbackConfig, TagDefinition } from '../shared/types';

export type ComputedTagPlugin = {
  name?: string;
  tag: (record: unknown, context: ComputedTagContext) => unknown;
};

export type ComputedTagContext = {
  schema: unknown;
  tagsPath: string;
  manualTagDefinitions: TagDefinition[];
};

export type ReconcileTagsResult = {
  data: unknown;
  pluginErrors: string[];
};

export const MAX_TAGS_PER_RECORD = 100;
export const MAX_TAG_LENGTH = 100;

export const loadManualTagDefinitionsFromDirectories = async (directories: Array<string | undefined>): Promise<TagDefinition[]> => {
  const definitions = new Map<string, TagDefinition>();
  for (const directory of directories) {
    if (!directory) {
      continue;
    }
    const filePath = path.join(directory, 'tags.json');
    const content = await readOptionalTextFile(filePath);
    if (content === undefined) {
      continue;
    }
    for (const definition of parseManualTagDefinitions(content, filePath)) {
      if (!definitions.has(definition.name)) {
        definitions.set(definition.name, definition);
      }
    }
  }
  return [...definitions.values()];
};

export const loadManualTagDefinitionsFromValues = (values: Array<unknown | undefined>): TagDefinition[] => {
  const definitions = new Map<string, TagDefinition>();
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    for (const definition of normalizeManualTagDefinitions(value, 'config/tags.json')) {
      if (!definitions.has(definition.name)) {
        definitions.set(definition.name, definition);
      }
    }
  }
  return [...definitions.values()];
};

export const discoverComputedTagPlugins = async (directories: Array<string | undefined>): Promise<Array<ComputedTagPlugin | Error>> => {
  const files: string[] = [];
  for (const directory of directories) {
    if (!directory) {
      continue;
    }
    const entries = await readOptionalDirectory(directory);
    files.push(
      ...entries
        .filter((entry) => entry.isFile() && isPluginFile(entry.name))
        .map((entry) => path.join(directory, entry.name))
        .sort((left, right) => left.localeCompare(right))
    );
  }
  const plugins: Array<ComputedTagPlugin | Error> = [];
  for (const file of files) {
    try {
      const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
      const candidate = module.default ?? module.plugin ?? module;
      if (isTagPlugin(candidate)) {
        plugins.push(candidate as ComputedTagPlugin);
      } else {
        plugins.push(new Error(`Tag plugin ${path.basename(file)} must export a tag(record, context) function.`));
      }
    } catch (error) {
      plugins.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return plugins;
};

export const reconcileComputedTags = (
  schema: unknown,
  feedbackConfig: FeedbackConfig,
  data: unknown,
  manualTagDefinitions: TagDefinition[],
  plugins: Array<ComputedTagPlugin | Error>
): ReconcileTagsResult => {
  const tagsPath = tagsMappingPath(feedbackConfig);
  if (!tagsPath) {
    return { data, pluginErrors: [] };
  }
  const pluginErrors: string[] = [];
  const context: ComputedTagContext = { schema, tagsPath, manualTagDefinitions };
  for (const plugin of plugins) {
    if (plugin instanceof Error) {
      pluginErrors.push(plugin.message);
      continue;
    }
    try {
      const result = plugin.tag(data, context);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        throw new Error('Tag plugins must run synchronously.');
      }
    } catch (error) {
      pluginErrors.push(`${plugin.name ?? 'tag plugin'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  normalizeTagsAtPath(data, tagsPath);
  return { data, pluginErrors };
};

export const tagPluginWarning = (errors: string[], successMessage = 'Save succeeded'): string | undefined =>
  errors.length === 0 ? undefined : `${successMessage}, but ${errors.length} tag plugin${errors.length === 1 ? '' : 's'} failed. ${errors.join('; ')}`;

export const tagsMappingPath = (feedbackConfig: FeedbackConfig): string | undefined =>
  Object.values(feedbackConfig.properties).find((entry) => entry.mapping === 'tags')?.path;

const normalizeTagsAtPath = (data: unknown, tagsPath: string): void => {
  const current = readJsonPointer(data, tagsPath);
  if (current === undefined) {
    writeJsonPointer(data, tagsPath, []);
    return;
  }
  if (!Array.isArray(current) || !current.every((item) => typeof item === 'string')) {
    throw new Error('Tags must be stored as an array of strings.');
  }
  const tags = [...new Set(current.map((item) => item.trim()).filter(Boolean))];
  if (tags.length > MAX_TAGS_PER_RECORD) {
    throw new Error(`A record cannot persist more than ${MAX_TAGS_PER_RECORD} tags.`);
  }
  const tooLong = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (tooLong) {
    throw new Error(`Tag exceeds ${MAX_TAG_LENGTH} characters: ${tooLong}`);
  }
  writeJsonPointer(data, tagsPath, tags);
};

const parseManualTagDefinitions = (content: string, source: string): TagDefinition[] =>
  normalizeManualTagDefinitions(JSON.parse(content) as unknown, source);

const normalizeManualTagDefinitions = (value: unknown, source: string): TagDefinition[] => {
  const entries = Array.isArray(value) ? value : isPlainRecord(value) && Array.isArray(value.tags) ? value.tags : undefined;
  if (!entries) {
    throw new Error(`${source} must contain an array of tag definitions or an object with a tags array.`);
  }
  const definitions: TagDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isPlainRecord(entry) || typeof entry.name !== 'string' || typeof entry.description !== 'string') {
      throw new Error(`${source} tag definitions must include name and description fields.`);
    }
    const name = entry.name.trim();
    if (!name || name.length > MAX_TAG_LENGTH || seen.has(name)) {
      continue;
    }
    seen.add(name);
    definitions.push({ name, description: entry.description });
  }
  return definitions;
};

const readOptionalTextFile = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readOptionalDirectory = async (directory: string): Promise<import('node:fs').Dirent[]> => {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const isPluginFile = (name: string): boolean => path.extname(name) === '.mjs';

const readJsonPointer = (data: unknown, pointer: string): unknown => {
  if (!pointer.startsWith('/')) {
    return data;
  }
  return pointer
    .slice(1)
    .split('/')
    .map(unescapePointer)
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) {
        const index = Number(segment);
        return Number.isInteger(index) ? current[index] : undefined;
      }
      return isPlainRecord(current) ? current[segment] : undefined;
    }, data);
};

const writeJsonPointer = (data: unknown, pointer: string, value: unknown): void => {
  if (!isPlainRecord(data)) {
    throw new Error('Tags can only be written to object records.');
  }
  const segments = pointer.slice(1).split('/').map(unescapePointer);
  let current: Record<string, unknown> = data;
  for (const [index, segment] of segments.entries()) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new Error('Invalid tags path.');
    }
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    if (!isPlainRecord(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
};

const unescapePointer = (value: string): string => value.replace(/~1/g, '/').replace(/~0/g, '~');

const isTagPlugin = (value: unknown): value is ComputedTagPlugin => isPlainRecord(value) && typeof value.tag === 'function';

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
