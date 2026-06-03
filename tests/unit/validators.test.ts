import { describe, expect, it } from 'vitest';
import {
  assertAgentStatus,
  assertBootstrap,
  assertChatStreamChunk,
  assertChatStreamStart,
  assertChatHistory,
  assertContinueWithGitHubResult,
  assertGitHubLoginCompletion,
  assertChatMessage,
  assertNewProjectId,
  assertFeedbackConfig,
  assertOpenProjectResult,
  assertProjectId,
  assertRecordDetail,
  assertRecordId,
  ValidationError
} from '../../src/shared/validators';

describe('IPC boundary validators', () => {
  it('accepts valid identifiers and rejects traversal-style input', () => {
    expect(assertProjectId('sample-project')).toBe('sample-project');
    expect(assertRecordId('valid-record')).toBe('valid-record');
    expect(assertNewProjectId('new-project')).toBe('new-project');

    expect(() => assertProjectId('../sample-project')).toThrow(ValidationError);
    expect(() => assertProjectId('nested/project')).toThrow(ValidationError);
    expect(() => assertRecordId('..\\valid-record')).toThrow(ValidationError);
    expect(() => assertNewProjectId('Bad Name')).toThrow('Project name must be 3-63 characters');
  });

  it('requires chat messages to be non-empty and bounded', () => {
    expect(assertChatMessage('review this')).toBe('review this');
    expect(() => assertChatMessage('')).toThrow('Chat message must be non-empty');
    expect(() => assertChatMessage('x'.repeat(20001))).toThrow('Chat message must be non-empty');
  });

  it('validates bounded user and assistant chat history for provider context', () => {
    expect(
      assertChatHistory([
        { id: 'user-1', role: 'user', content: 'search for "configuration management"', createdAt: '2026-06-02T12:00:00.000Z' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Found vinsol/nectarcommerce README.md.',
          createdAt: '2026-06-02T12:00:01.000Z'
        }
      ])
    ).toEqual([
      { id: 'user-1', role: 'user', content: 'search for "configuration management"', createdAt: '2026-06-02T12:00:00.000Z' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Found vinsol/nectarcommerce README.md.',
        createdAt: '2026-06-02T12:00:01.000Z'
      }
    ]);
    expect(() =>
      assertChatHistory([{ id: 'pending', role: 'assistant', content: '', createdAt: '2026-06-02T12:00:02.000Z' }])
    ).toThrow('Chat history messages must be non-empty');
    expect(() =>
      assertChatHistory([{ id: 'system-1', role: 'system', content: 'Provider error', createdAt: '2026-06-02T12:00:02.000Z' }])
    ).toThrow('Chat history can only include user and assistant messages');
  });

  it('validates response shapes that cross preload and IPC boundaries', () => {
    expect(
      assertBootstrap({
        backendKind: 'local',
        projects: [{ id: 'sample-project', name: 'sample-project' }],
        version: 'v0.1.0-test',
        autoOpenFirst: true
      })
    ).toMatchObject({ backendKind: 'local', autoOpenFirst: true });

    expect(() =>
      assertBootstrap({
        projects: [{ id: 'sample-project', name: 'sample-project' }],
        version: 'v0.1.0-test',
        autoOpenFirst: 'yes'
      })
    ).toThrow(ValidationError);

    expect(
      assertOpenProjectResult({
        project: { id: 'sample-project', name: 'sample-project' },
        schema: { type: 'object' },
        records: [{ id: 'valid-record', displayName: 'valid-record' }],
        projectConfig: { LOCAL_PATH: '/tmp/projects', IGNORED: 123 }
      }).projectConfig
    ).toEqual({ LOCAL_PATH: '/tmp/projects' });

    expect(
      assertRecordDetail({
        projectId: 'sample-project',
        recordId: 'valid-record',
        displayName: 'valid-record',
        data: {},
        schema: {},
        validationIssues: [],
        renderTree: { kind: 'object', label: 'record', children: [], validationIssues: [] }
      }).recordId
    ).toBe('valid-record');

    expect(() => assertBootstrap({ projects: [] })).toThrow(ValidationError);
    expect(() => assertOpenProjectResult({ projectConfig: {}, records: [] })).toThrow(ValidationError);
    expect(() => assertRecordDetail({ projectId: 'sample-project', recordId: 'valid-record' })).toThrow(ValidationError);
  });

  it('preserves feedback edit modes across IPC boundaries', () => {
    expect(
      assertFeedbackConfig({
        properties: {
          '/answer': {
            path: '/answer',
            target: 'Answer',
            tab: 'Main',
            supportsEdit: true,
            feedback: 'none',
            comments: false,
            editMode: 'inline'
          },
          '/evidence': {
            path: '/evidence',
            target: 'Evidence',
            tab: 'Main',
            supportsEdit: false,
            feedback: 'none',
            comments: false,
            editMode: 'logged'
          }
        }
      })
    ).toEqual({
      properties: {
        '/answer': expect.objectContaining({ editMode: 'inline' }),
        '/evidence': expect.objectContaining({ supportsEdit: false, editMode: 'none' })
      }
    });
    expect(() =>
      assertFeedbackConfig({
        properties: {
          '/answer': {
            path: '/answer',
            target: 'Answer',
            tab: 'Main',
            supportsEdit: true,
            feedback: 'none',
            comments: false,
            editMode: 'sideways'
          }
        }
      })
    ).toThrow(ValidationError);
  });

  it('validates streamed chat IPC payloads', () => {
    expect(
      assertAgentStatus({
        provider: { id: 'github-copilot', name: 'GitHub Copilot' },
        availability: 'ready'
      }).availability
    ).toBe('ready');
    expect(assertChatStreamStart({ requestId: 'request-1', messageId: 'message-1' })).toEqual({
      requestId: 'request-1',
      messageId: 'message-1'
    });
    expect(assertChatStreamChunk({ requestId: 'request-1', messageId: 'message-1', content: 'partial' }).content).toBe('partial');
    expect(() => assertAgentStatus({ provider: { id: 'github-copilot', name: 'GitHub Copilot' }, availability: 'offline' })).toThrow(
      ValidationError
    );
    expect(() => assertChatStreamStart({ requestId: 'request-1' })).toThrow(ValidationError);
    expect(() => assertChatStreamChunk({ requestId: 'request-1', messageId: 'message-1' })).toThrow(ValidationError);
  });

  it('validates GitHub continuation responses', () => {
    expect(
      assertContinueWithGitHubResult({
        opened: true,
        loginId: 'login-1',
        deviceCode: '1234-ABCD',
        verificationUri: 'https://github.com/login/device',
        copiedToClipboard: true
      })
    ).toEqual({
      opened: true,
      loginId: 'login-1',
      deviceCode: '1234-ABCD',
      verificationUri: 'https://github.com/login/device',
      copiedToClipboard: true
    });
    expect(() => assertContinueWithGitHubResult({ opened: 'true' })).toThrow(ValidationError);
    expect(assertGitHubLoginCompletion({ loginId: 'login-1', success: true })).toEqual({ loginId: 'login-1', success: true });
    expect(() => assertGitHubLoginCompletion({ loginId: 'login-1', success: 'true' })).toThrow(ValidationError);
  });
});
