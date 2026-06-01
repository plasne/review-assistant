type LogFields = Record<string, unknown>;

export const logInfo = (event: string, fields: LogFields = {}): void => {
  console.info(formatLogLine(event, fields));
};

export const logError = (event: string, fields: LogFields = {}): void => {
  console.error(formatLogLine(event, fields));
};

export const formatLogLine = (event: string, fields: LogFields = {}): string => {
  const timestamp = new Date().toISOString();
  const fieldText = Object.entries(fields)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  return fieldText ? `${timestamp} ${event} ${fieldText}` : `${timestamp} ${event}`;
};

const formatLogValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value.replace(/\s+/g, ' ').trim());
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(value);
};
