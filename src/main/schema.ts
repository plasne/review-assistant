import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { displayConfigEntryForPath } from '../shared/display';
import type { DisplayConfig, FieldPresentation, RenderNode, ValidationIssue } from '../shared/types';

type JsonSchema = Record<string, unknown>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});
addFormats(ajv);

export const validateRecord = (schema: unknown, data: unknown): ValidationIssue[] => {
  const validate = compileSchema(schema);
  validate(data);
  return (validate.errors ?? []).map(toValidationIssue);
};

export const buildRenderTree = (schema: unknown, data: unknown, issues: ValidationIssue[], label = 'record', displayConfig?: DisplayConfig): RenderNode => {
  if (!isSchema(schema)) {
    return rawNode(label, undefined, data, 'Schema is not an object.', issues, '');
  }
  const resolved = resolveRenderableSchema(schema);
  return renderSchema(label, resolved, data, issues, '', displayConfig);
};

const compileSchema = (schema: unknown): ValidateFunction => {
  if (!isSchema(schema)) {
    throw new Error('Project _schema.json must be a JSON object.');
  }
  return ajv.compile(schema);
};

const renderSchema = (label: string, schema: JsonSchema, data: unknown, issues: ValidationIssue[], path: string, displayConfig?: DisplayConfig): RenderNode => {
  const localIssues = issues.filter((issue) => issue.path === path);
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const presentation = displayConfig ? displayConfigEntryForPath(displayConfig, path)?.presentation : undefined;
  const renderable = resolveRenderableSchema(schema);
  if (hasComplexConstruct(renderable)) {
    return rawNode(label, description, data, 'Complex JSON Schema construct is validated and displayed as read-only JSON.', localIssues, path, presentation);
  }
  const type = inferType(renderable, data);
  if (type === 'object') {
    const properties = isSchemaMap(renderable.properties) ? renderable.properties : {};
    const value = isPlainRecord(data) ? data : {};
    const children = Object.entries(properties).map(([childLabel, childSchema]) =>
      renderSchema(childLabel, childSchema, value[childLabel], issues, `${path}/${escapePointer(childLabel)}`, displayConfig)
    );
    const extraChildren = Object.keys(value)
      .filter((key) => !(key in properties))
      .sort()
      .map((key) =>
        rawNode(
          key,
          undefined,
          value[key],
          'Field is present in data but not declared by schema.',
          issuesAt(issues, `${path}/${escapePointer(key)}`),
          `${path}/${escapePointer(key)}`,
          displayConfig ? displayConfigEntryForPath(displayConfig, `${path}/${escapePointer(key)}`)?.presentation : undefined
        )
      );
    return { kind: 'object', label, path, description, presentation, children: [...children, ...extraChildren], validationIssues: localIssues };
  }
  if (type === 'array') {
    const itemsSchema = isSchema(renderable.items) ? renderable.items : {};
    const items = Array.isArray(data)
      ? data.map((item, index) => renderSchema(String(index), itemsSchema, item, issues, `${path}/${index}`, displayConfig))
      : [];
    return { kind: 'array', label, path, description, presentation, items, validationIssues: localIssues };
  }
  return {
    kind: 'value',
    label,
    path,
    description,
    presentation,
    value: data,
    type: typeof renderable.type === 'string' ? renderable.type : typeof data,
    enumValues: Array.isArray(renderable.enum) ? renderable.enum : undefined,
    validationIssues: localIssues
  };
};

const resolveRenderableSchema = (schema: JsonSchema): JsonSchema => {
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.filter(isSchema).reduce<JsonSchema>((merged, current) => mergeSchemas(merged, current), { ...schema, allOf: undefined });
  }
  return schema;
};

const mergeSchemas = (left: JsonSchema, right: JsonSchema): JsonSchema => {
  const merged: JsonSchema = { ...left, ...right };
  if (isSchemaMap(left.properties) || isSchemaMap(right.properties)) {
    merged.properties = { ...(isSchemaMap(left.properties) ? left.properties : {}), ...(isSchemaMap(right.properties) ? right.properties : {}) };
  }
  return merged;
};

const hasComplexConstruct = (schema: JsonSchema): boolean =>
  ['$ref', 'oneOf', 'anyOf', 'if', 'then', 'else', 'not', 'dependentSchemas', 'patternProperties'].some((key) => key in schema);

const inferType = (schema: JsonSchema, data: unknown): string => {
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  if (Array.isArray(schema.type) && typeof schema.type[0] === 'string') {
    return schema.type[0];
  }
  if (isPlainRecord(schema.properties) || isPlainRecord(data)) {
    return 'object';
  }
  if (Array.isArray(data)) {
    return 'array';
  }
  return typeof data;
};

const rawNode = (
  label: string,
  description: string | undefined,
  value: unknown,
  reason: string,
  validationIssues: ValidationIssue[],
  path?: string,
  presentation?: FieldPresentation
): RenderNode => ({
  kind: 'raw',
  label,
  path,
  description,
  presentation,
  value,
  reason,
  validationIssues
});

const toValidationIssue = (error: ErrorObject): ValidationIssue => ({
  path: error.instancePath || '/',
  message: formatValidationMessage(error),
  keyword: error.keyword
});

const formatValidationMessage = (error: ErrorObject): string => {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `Missing required field: ${String(error.params.missingProperty)}`;
  }
  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `Field is not defined in the schema: ${String(error.params.additionalProperty)}`;
  }
  if (error.keyword === 'enum' && 'allowedValues' in error.params && Array.isArray(error.params.allowedValues)) {
    return `Value must be one of: ${error.params.allowedValues.map(formatSchemaValue).join(', ')}`;
  }
  if (error.keyword === 'type' && 'type' in error.params) {
    return `Value must be ${String(error.params.type)}`;
  }
  if (error.keyword === 'minItems' && 'limit' in error.params) {
    return `Must include at least ${String(error.params.limit)} item${Number(error.params.limit) === 1 ? '' : 's'}`;
  }
  if (error.keyword === 'maxItems' && 'limit' in error.params) {
    return `Must include at most ${String(error.params.limit)} item${Number(error.params.limit) === 1 ? '' : 's'}`;
  }
  return error.message ?? 'Invalid value';
};

const formatSchemaValue = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const issuesAt = (issues: ValidationIssue[], path: string): ValidationIssue[] => issues.filter((issue) => issue.path === path);

const isSchema = (value: unknown): value is JsonSchema => isPlainRecord(value);

const isSchemaMap = (value: unknown): value is Record<string, JsonSchema> =>
  isPlainRecord(value) && Object.values(value).every(isSchema);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const escapePointer = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');
