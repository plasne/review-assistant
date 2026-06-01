import { describe, expect, it } from 'vitest';
import { normalizeProviderError } from '../../src/main/agent';

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
