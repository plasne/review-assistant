import type { ExternalMcpServerConfig } from '../shared/types';

type RawMcpServerConfig = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  timeout?: unknown;
  allowedTools?: unknown;
};

export const parseExternalMcpServers = (content: string | undefined, values: Record<string, string>): ExternalMcpServerConfig[] => {
  if (!content?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Invalid _mcp.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error('Invalid _mcp.json: expected an object with an mcpServers object.');
  }

  return Object.entries(parsed.mcpServers).map(([id, rawServer]) => parseServer(id, rawServer, values));
};

export const mergeExternalMcpServers = (
  appServers: ExternalMcpServerConfig[],
  projectServers: ExternalMcpServerConfig[]
): ExternalMcpServerConfig[] => {
  const merged = new Map<string, ExternalMcpServerConfig>();
  for (const server of appServers) {
    merged.set(server.id, server);
  }
  for (const server of projectServers) {
    merged.set(server.id, server);
  }
  return [...merged.values()];
};

const parseServer = (id: string, rawServer: unknown, values: Record<string, string>): ExternalMcpServerConfig => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid _mcp.json: MCP server id must contain only letters, numbers, underscores, or hyphens: ${id}`);
  }
  if (!isRecord(rawServer)) {
    throw new Error(`Invalid _mcp.json: MCP server ${id} must be an object.`);
  }

  const server = rawServer as RawMcpServerConfig;
  if (typeof server.command !== 'string' || server.command.trim() === '') {
    throw new Error(`Invalid _mcp.json: MCP server ${id} must include a command.`);
  }

  return {
    id,
    command: server.command,
    args: parseStringArray(server.args, `MCP server ${id} args`, []),
    ...(server.timeout === undefined ? {} : { timeout: parseTimeout(server.timeout, id) }),
    ...(server.env === undefined ? {} : { env: parseEnv(server.env, values, id) }),
    ...(server.allowedTools === undefined ? {} : { allowedTools: parseStringArray(server.allowedTools, `MCP server ${id} allowedTools`) })
  };
};

const parseEnv = (value: unknown, values: Record<string, string>, id: string): Record<string, string> => {
  if (!isRecord(value)) {
    throw new Error(`Invalid _mcp.json: MCP server ${id} env must be an object.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => {
      if (typeof rawValue !== 'string') {
        throw new Error(`Invalid _mcp.json: MCP server ${id} env.${key} must be a string.`);
      }
      return [key, expandEnvValue(rawValue, values, id)];
    })
  );
};

const expandEnvValue = (value: string, values: Record<string, string>, id: string): string =>
  value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const resolved = values[key] ?? process.env[key];
    if (resolved === undefined) {
      throw new Error(`Invalid _mcp.json: MCP server ${id} references missing environment value ${key}.`);
    }
    return resolved;
  });

const parseStringArray = (value: unknown, label: string, defaultValue?: string[]): string[] => {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid _mcp.json: ${label} must be a string array.`);
  }
  return value;
};

const parseTimeout = (value: unknown, id: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid _mcp.json: MCP server ${id} timeout must be a positive integer.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
