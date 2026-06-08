import { describe, expect, it } from 'vitest';
import {
  assertAgentStatus,
  assertBootstrap,
  assertChatAttachmentContents,
  assertChatAttachments,
  assertChatAttachmentSelectionResult,
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
  assertTheme,
  assertThemeId,
  assertThemeState,
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

  it('validates chat attachments at IPC and main-process boundaries', () => {
    const attachment = {
      id: 'attachment-1',
      name: 'notes.md',
      path: '/Users/sme/notes.md',
      sizeBytes: 128
    };
    expect(assertChatAttachments([attachment])).toEqual([attachment]);
    expect(assertChatAttachmentSelectionResult({ attachments: [attachment] })).toEqual({ attachments: [attachment] });
    expect(assertChatAttachmentSelectionResult({ attachments: [] })).toEqual({ attachments: [] });
    expect(assertChatAttachmentContents([{ ...attachment, content: 'Important context.' }])).toEqual([{ ...attachment, content: 'Important context.' }]);
    expect(() => assertChatAttachments(Array.from({ length: 6 }, (_, index) => ({ ...attachment, id: `attachment-${index}` })))).toThrow(
      'Chat attachments must include at most 5 files'
    );
    expect(() => assertChatAttachments([{ ...attachment, sizeBytes: -1 }])).toThrow('Chat attachment size must be a non-negative number');
    expect(() => assertChatAttachmentContents([{ ...attachment, content: 'x'.repeat(60_001) }])).toThrow(
      'Chat attachment content must be text under 60,000 characters'
    );
  });

  it('validates response shapes that cross preload and IPC boundaries', () => {
    expect(
      assertBootstrap({
        backendKind: 'local',
        projects: [{ id: 'sample-project', name: 'sample-project' }],
        themeState: {
          activeThemeId: 'default',
          themes: [
            {
              id: 'default',
              name: 'Default',
              builtIn: true,
              tokens: {
                bg: '#101827',
                bg2: '#0d1320',
                surface: '#182338',
                surface2: '#27344d',
                border: '#30415f',
                text: '#f4f7fb',
                textDim: '#aebbd0',
                accent: '#0969da',
                accent2: '#58a6ff',
                success: '#2f6f4f',
                warning: '#ffd166',
                danger: '#ff9aa8',
                focusRing: '#8bd3ff',
                fontSans: 'Inter, sans-serif'
              }
            }
          ]
        },
        version: 'v0.1.0-test'
      })
    ).toMatchObject({ backendKind: 'local' });

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

  it('preserves unified config fields across IPC boundaries', () => {
    expect(
      assertFeedbackConfig({
        properties: {
          '/answer': {
            path: '/answer',
            target: 'Answer',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            presentation: 'chat-response',
            mapping: 'response',
            editMode: 'inline'
          },
          '/evidence': {
            path: '/evidence',
            target: 'Evidence',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            presentation: 'evidence-list',
            mapping: 'evidence'
          }
        }
      })
    ).toEqual({
      properties: {
        '/answer': expect.objectContaining({ presentation: 'chat-response', mapping: 'response', editMode: 'inline' }),
        '/evidence': expect.objectContaining({ presentation: 'evidence-list', mapping: 'evidence' })
      }
    });
    expect(() =>
      assertFeedbackConfig({
        properties: {
          '/answer': {
            path: '/answer',
            target: 'Answer',
            tab: 'Main',
            feedback: 'none',
            comments: false,
            editMode: 'sideways'
          }
        }
      })
    ).toThrow(ValidationError);
    expect(() =>
      assertFeedbackConfig({
        properties: {
          '/request': { path: '/request', target: 'Request', tab: 'Main', feedback: 'none', comments: false, mapping: 'request' },
          '/question': { path: '/question', target: 'Question', tab: 'Main', feedback: 'none', comments: false, mapping: 'request' }
        }
      })
    ).toThrow(ValidationError);
  });

  it('validates theme contracts at shared process boundaries', () => {
    const theme = {
      id: 'custom-focus',
      name: 'Custom Focus',
      builtIn: false,
      tokens: {
        bg: '#101010',
        bg2: '#151515',
        surface: '#202020',
        surface2: '#2a2a2a',
        border: '#404040',
        text: '#f5f5f5',
        textDim: '#bbbbbb',
        accent: '#44ccff',
        accent2: '#ffaa44',
        success: '#55cc88',
        warning: '#ffcc55',
        danger: '#ff6677',
        focusRing: '#88ddff',
        fontSans: 'Inter, sans-serif',
        fontSerif: 'Georgia, serif'
      }
    };

    expect(assertThemeId(theme.id)).toBe(theme.id);
    expect(assertTheme(theme)).toEqual(theme);
    expect(assertThemeState({ activeThemeId: theme.id, themes: [theme] })).toEqual({ activeThemeId: theme.id, themes: [theme] });
    expect(() => assertThemeId('Bad Theme')).toThrow(ValidationError);
    expect(() => assertTheme({ ...theme, tokens: { ...theme.tokens, textDim: '' } })).toThrow('Theme token textDim must be a non-empty string');
    expect(() => assertThemeState({ activeThemeId: 'missing-theme', themes: [theme] })).toThrow('Active theme identifier must reference an available theme');
    expect(() => assertThemeState({ activeThemeId: theme.id, themes: [theme, theme] })).toThrow('Theme identifiers must be unique');
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
