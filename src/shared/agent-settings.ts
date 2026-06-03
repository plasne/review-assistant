import type { AgentReasoningEffort, AgentSettings } from './types';

export const AGENT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentReasoningEffort[];

export class AgentSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSettingsError';
  }
}

export const parseAgentSettingsFromEnvValues = (values: Record<string, string | undefined>): AgentSettings => {
  const settings: AgentSettings = {};
  const model = optionalTrimmed(values.AGENT_MODEL);
  if (model !== undefined) {
    if (model.length > 128 || /[\s\0-\x1F\x7F]/.test(model)) {
      throw new AgentSettingsError('AGENT_MODEL must be a non-whitespace model identifier under 129 characters.');
    }
    settings.model = model;
  }

  const reasoningEffort = optionalTrimmed(values.REASONING_EFFORT);
  if (reasoningEffort !== undefined) {
    if (!isAgentReasoningEffort(reasoningEffort)) {
      throw new AgentSettingsError(`REASONING_EFFORT must be one of: ${AGENT_REASONING_EFFORTS.join(', ')}.`);
    }
    settings.reasoningEffort = reasoningEffort;
  }

  return settings;
};

export const parseAgentSettingsJson = (value: string | undefined): AgentSettings => {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AgentSettingsError(`Invalid AGENT_SETTINGS JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new AgentSettingsError('AGENT_SETTINGS must be a JSON object.');
  }
  return parseAgentSettingsFromEnvValues({
    AGENT_MODEL: stringValue(parsed.model),
    REASONING_EFFORT: stringValue(parsed.reasoningEffort)
  });
};

export const configuredAgentSettingKeys = (settings: AgentSettings): Array<keyof AgentSettings> =>
  (['model', 'reasoningEffort'] as const).filter((key) => settings[key] !== undefined);

const optionalTrimmed = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const isAgentReasoningEffort = (value: string): value is AgentReasoningEffort =>
  AGENT_REASONING_EFFORTS.includes(value as AgentReasoningEffort);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
