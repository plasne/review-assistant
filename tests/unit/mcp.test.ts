import { describe, expect, it } from 'vitest';
import { mergeExternalMcpServers, parseExternalMcpServers } from '../../src/main/mcp';

describe('external MCP config', () => {
  it('returns no external MCP servers when no project config file exists', () => {
    expect(parseExternalMcpServers(undefined, {})).toEqual([]);
  });

  it('parses arbitrary MCP servers from a dropped JSON file', () => {
    expect(
      parseExternalMcpServers(
        JSON.stringify({
          mcpServers: {
            github: {
              command: 'docker',
              args: ['run', '--rm', '-i', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
              allowedTools: ['search_code', 'get_file_contents']
            },
            docs: {
              command: 'internal-docs-mcp',
              args: ['stdio'],
              timeout: 9000
            }
          }
        }),
        { GITHUB_TOKEN: 'secret-token' }
      )
    ).toEqual([
      {
        id: 'github',
        command: 'docker',
        args: ['run', '--rm', '-i', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret-token' },
        allowedTools: ['search_code', 'get_file_contents']
      },
      {
        id: 'docs',
        command: 'internal-docs-mcp',
        args: ['stdio'],
        timeout: 9000
      }
    ]);
  });

  it('fails clearly when an environment reference cannot be resolved', () => {
    expect(() =>
      parseExternalMcpServers(
        JSON.stringify({
          mcpServers: {
            github: {
              command: 'github-mcp-server',
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${MISSING_TOKEN}' }
            }
          }
        }),
        {}
      )
    ).toThrow('Invalid config/mcp.json: MCP server github references missing environment value MISSING_TOKEN.');
  });

  it('merges app-level and project-level servers with project overrides by id', () => {
    expect(
      mergeExternalMcpServers(
        [
          { id: 'shared', command: 'app-shared-mcp', args: [] },
          { id: 'docs', command: 'docs-mcp', args: ['stdio'] }
        ],
        [
          { id: 'shared', command: 'project-shared-mcp', args: ['project'], allowedTools: ['search'] },
          { id: 'project-only', command: 'project-mcp', args: [] }
        ]
      )
    ).toEqual([
      { id: 'shared', command: 'project-shared-mcp', args: ['project'], allowedTools: ['search'] },
      { id: 'docs', command: 'docs-mcp', args: ['stdio'] },
      { id: 'project-only', command: 'project-mcp', args: [] }
    ]);
  });
});
