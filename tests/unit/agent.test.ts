import { describe, expect, it } from 'vitest';
import { localToolResultLogFields, normalizeProviderError } from '../../src/main/agent';

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
