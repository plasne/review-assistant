import { describe, expect, it } from 'vitest';
import { AgentRuntime, localToolResultLogFields, normalizeProviderError } from '../../src/main/agent';
import { DEFAULT_COPILOT_STATUS_TIMEOUT_MS } from '../../src/main/env';

describe('agent error normalization', () => {
  it('returns stable user-safe errors for provider failures', () => {
    expect(normalizeProviderError(new Error('spawn copilot ENOENT'))).toMatchObject({
      code: 'BINARY_NOT_FOUND',
      retryable: true
    });
    expect(normalizeProviderError(new Error('Authentication required; please login'))).toMatchObject({
      code: 'AUTH_REQUIRED',
      retryable: true
    });
    expect(normalizeProviderError(new Error('Context too large for GitHub Copilot request.'))).toMatchObject({
      code: 'CONTEXT_TOO_LARGE',
      retryable: false
    });
  });
});

describe('agent runtime status timeout configuration', () => {
  it('defaults Copilot status checks to 30 seconds and accepts an override', () => {
    const runtime = new AgentRuntime({ workerPath: '/tmp/agent-process.js' });
    expect(runtime.getStatusTimeoutMs()).toBe(DEFAULT_COPILOT_STATUS_TIMEOUT_MS);

    runtime.setStatusTimeoutMs(45000);
    expect(runtime.getStatusTimeoutMs()).toBe(45000);
  });
});

describe('local tool result log fields', () => {
  it('keeps only safe persistence metadata from successful tool results', () => {
    expect(
      localToolResultLogFields({
        requestId: 'tool-1',
        ok: true,
        result: {
          targetPath: '/turns/0',
          responseField: 'response',
          evidenceField: 'evidence',
          evidenceContainerPath: '/evidence',
          savedEvidenceCount: 2,
          savedItemCount: 3,
          containerItemCount: 5,
          turnIndex: 0,
          response: 'do not log me',
          evidence: [{ title: 'do not log me' }]
        }
      })
    ).toEqual({
      targetPath: '/turns/0',
      containerPath: undefined,
      responseField: 'response',
      evidenceField: 'evidence',
      evidenceContainerPath: '/evidence',
      savedEvidenceCount: 2,
      savedItemCount: 3,
      containerItemCount: 5,
      turnIndex: 0
    });
  });

  it('does not emit metadata for failed tool calls', () => {
    expect(
      localToolResultLogFields({
        requestId: 'tool-1',
        ok: false,
        error: {
          code: 'INVALID_TOOL_ARGUMENTS',
          message: 'bad input',
          retryable: false
        }
      })
    ).toEqual({});
  });
});
