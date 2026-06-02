import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, RenderTree } from '../../src/renderer/main';
import type { Api, ChatCanceled, ChatStreamChunk, ChatStreamComplete, ChatStreamError, GitHubLoginCompletion, RenderNode } from '../../src/shared/types';

type ListenerMap = {
  chunk: ((chunk: ChatStreamChunk) => void)[];
  complete: ((complete: ChatStreamComplete) => void)[];
  error: ((error: ChatStreamError) => void)[];
  canceled: ((canceled: ChatCanceled) => void)[];
  loginComplete: ((completion: GitHubLoginCompletion) => void)[];
};

const listeners: ListenerMap = {
  chunk: [],
  complete: [],
  error: [],
  canceled: [],
  loginComplete: []
};

const api: Api = {
  getBootstrap: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  openProject: vi.fn(),
  getRecord: vi.fn(),
  getFeedbackConfig: vi.fn(),
  saveFeedbackConfig: vi.fn(),
  getProjectUser: vi.fn(),
  submitFeedback: vi.fn(),
  getAgentStatus: vi.fn(),
  continueWithGitHub: vi.fn(),
  startChat: vi.fn(),
  cancelChat: vi.fn(),
  onGitHubLoginComplete: vi.fn((listener) => {
    listeners.loginComplete.push(listener);
    return () => {
      listeners.loginComplete = listeners.loginComplete.filter((item) => item !== listener);
    };
  }),
  onChatChunk: vi.fn((listener) => {
    listeners.chunk.push(listener);
    return () => {
      listeners.chunk = listeners.chunk.filter((item) => item !== listener);
    };
  }),
  onChatComplete: vi.fn((listener) => {
    listeners.complete.push(listener);
    return () => {
      listeners.complete = listeners.complete.filter((item) => item !== listener);
    };
  }),
  onChatError: vi.fn((listener) => {
    listeners.error.push(listener);
    return () => {
      listeners.error = listeners.error.filter((item) => item !== listener);
    };
  }),
  onChatCanceled: vi.fn((listener) => {
    listeners.canceled.push(listener);
    return () => {
      listeners.canceled = listeners.canceled.filter((item) => item !== listener);
    };
  })
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners.chunk = [];
  listeners.complete = [];
  listeners.error = [];
  listeners.canceled = [];
  listeners.loginComplete = [];
  vi.mocked(api.getAgentStatus).mockResolvedValue({
    provider: { id: 'github-copilot', name: 'GitHub Copilot' },
    availability: 'ready'
  });
  vi.mocked(api.getProjectUser).mockResolvedValue({ username: 'sme@example.com', valid: true });
  vi.mocked(api.saveFeedbackConfig).mockImplementation(async (_projectId, config) => config);
  vi.mocked(api.continueWithGitHub).mockResolvedValue({
    opened: true,
    loginId: 'login-1',
    deviceCode: '1234-ABCD',
    verificationUri: 'https://github.com/login/device',
    copiedToClipboard: true
  });
  window.reviewAssistant = api;
});

describe('review UI', () => {
  it('renders request and response presentations with distinct classes', () => {
    render(
      <RenderTree
        node={{
          kind: 'object',
          label: 'turn',
          path: '/turns/0',
          children: [
            { kind: 'value', label: 'request', path: '/turns/0/request', value: 'What happened?', presentation: 'chat-request', validationIssues: [] },
            { kind: 'value', label: 'response', path: '/turns/0/response', value: 'It succeeded.', presentation: 'chat-response', validationIssues: [] }
          ],
          validationIssues: []
        }}
      />
    );

    expect(screen.getByText('What happened?').closest('details')).toHaveClass('presentation-chat-request');
    expect(screen.getByText('It succeeded.').closest('details')).toHaveClass('presentation-chat-response');
    expect(screen.getByText('What happened?').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('It succeeded.').closest('details')).toHaveAttribute('open');
  });

  it('renders evidence lists compactly with editable and read-only indicators', () => {
    const onSubmitFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'evidence',
          path: '/turns/0/evidence',
          presentation: 'evidence-list',
          items: [
            {
              kind: 'object',
              label: '0',
              path: '/turns/0/evidence/0',
              children: [
                { kind: 'value', label: 'id', path: '/turns/0/evidence/0/id', value: 'doc-1', validationIssues: [] },
                { kind: 'value', label: 'source', path: '/turns/0/evidence/0/source', value: 'Architecture Notes', validationIssues: [] },
                { kind: 'value', label: 'content', path: '/turns/0/evidence/0/content', value: 'The dial path enters through Dial Gateway.', validationIssues: [] }
              ],
              validationIssues: []
            }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/turns/*/evidence/*/id': {
              path: '/turns/*/evidence/*/id',
              target: 'Evidence > Id',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editable: false
            },
            '/turns/*/evidence/*/content': {
              path: '/turns/*/evidence/*/content',
              target: 'Evidence > Content',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'none',
              comments: true,
              editable: true
            }
          }
        }}
        history={{}}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={onSubmitFeedback}
      />
    );

    expect(screen.getByRole('heading', { name: 'Architecture Notes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Architecture Notes' }).closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText('Read-only evidence fields')).toBeInTheDocument();
    expect(screen.getByLabelText('Editable evidence fields')).toBeInTheDocument();
    expect(screen.getAllByText('doc-1').find((element) => element.closest('.evidence-field'))?.closest('.evidence-field')).toHaveClass('readonly');
    expect(screen.getByText('No edits yet.')).toBeInTheDocument();
    expect(screen.queryByText('The dial path enters through Dial Gateway.', { selector: 'dd' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Read-only').length).toBeGreaterThan(0);
    expect(screen.getByText('Editable')).toBeInTheDocument();
    const contentFeedback = screen.getByLabelText('content feedback');
    expect(contentFeedback).toBeInTheDocument();
    expect(contentFeedback.textContent?.indexOf('Edit')).toBeLessThan(contentFeedback.textContent?.indexOf('Comment') ?? 0);
    expect(screen.queryByLabelText('id feedback')).not.toBeInTheDocument();
  });

  it('supports project selection, record detail rendering, and chat', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [{ id: 'valid-record', displayName: 'valid-record' }]
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { question: 'How?' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [{ kind: 'value', label: 'question', value: 'How?', validationIssues: [] }],
        validationIssues: []
      }
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    expect(await screen.findByRole('button', { name: 'Configure' })).toBeDisabled();
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await waitFor(() => expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com'));
    const recordList = await screen.findByRole('region', { name: 'Records list' });
    const recordButton = await screen.findByRole('button', { name: 'valid-record' });
    expect(recordList).toContainElement(recordButton);
    await userEvent.click(recordButton);
    expect(await screen.findByText('Record passes schema validation.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'record' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'question' })).toBeInTheDocument();
    expect(screen.getByText('How?')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'hello'));
    act(() => {
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'Streamed ' }));
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'response' }));
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    expect(await screen.findByText('Streamed response')).toBeInTheDocument();
  });

  it('uses the displayed record detail as the chat record context', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [{ id: 'valid-record', displayName: 'valid-record' }]
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { question: 'How?' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [{ kind: 'value', label: 'question', value: 'How?', validationIssues: [] }],
        validationIssues: []
      }
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    await screen.findByText('How?');

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'who is the persona?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'who is the persona?'));
  });

  it('blocks browsing and shows configuration errors', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      configError: 'No supported backend configured.',
      projects: [],
      version: 'v0.1.0-test'
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No supported backend configured.');
    expect(screen.getByLabelText('Current project')).toBeDisabled();
  });

  it('disables send while GitHub Copilot is unavailable and recovers after a status refresh', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.getAgentStatus)
      .mockResolvedValueOnce({
        provider: { id: 'github-copilot', name: 'GitHub Copilot' },
        availability: 'unavailable',
        error: {
          code: 'AUTH_REQUIRED',
          message: 'GitHub Copilot is not signed in.',
          retryable: true,
          remediation: 'Run `copilot login`.'
        }
      })
      .mockResolvedValueOnce({
        provider: { id: 'github-copilot', name: 'GitHub Copilot' },
        availability: 'ready'
      });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: []
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('GitHub Copilot is not signed in.'));
    expect(screen.getByLabelText('Message GitHub Copilot')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    const continueButton = screen.getByRole('button', { name: 'Continue with GitHub' });
    expect(continueButton).toHaveClass('github-login-button');
    await userEvent.click(continueButton);
    expect(api.continueWithGitHub).toHaveBeenCalledOnce();
    expect(await screen.findByRole('dialog', { name: 'Login to GitHub Copilot' })).toBeVisible();
    expect(screen.getByLabelText('GitHub Copilot device code')).toHaveTextContent('1234-ABCD');
    expect(screen.getByText('Copied to clipboard')).toHaveClass('clipboard-status');
    act(() => {
      listeners.loginComplete.forEach((listener) => listener({ loginId: 'login-1', success: true }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Login to GitHub Copilot' })).not.toBeInTheDocument());

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('hides healthy agent status and keeps chat controls in one row', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });

    render(<App />);
    await screen.findByLabelText('Message GitHub Copilot');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    const loginButton = screen.getByRole('button', { name: 'Login' });
    expect(loginButton).toHaveClass('github-login-button');
    await userEvent.click(loginButton);
    expect(await screen.findByRole('dialog', { name: 'Login to GitHub Copilot' })).toBeVisible();
    expect(screen.getByText('Copied to clipboard')).toHaveClass('clipboard-status');
    act(() => {
      listeners.loginComplete.forEach((listener) => listener({ loginId: 'login-1', success: true }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Login to GitHub Copilot' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear chat' })).not.toBeInTheDocument();
  });

  it('allows chat before selecting a project without project or record context', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    const input = await screen.findByLabelText('Message GitHub Copilot');
    await userEvent.type(input, 'general question');

    expect(input).toHaveValue('general question');
    expect(screen.queryByText('No project selected. Project prompt and record context are unavailable.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'general question'));
  });

  it('renders assistant markdown tables and inline formatting', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.type(await screen.findByLabelText('Message GitHub Copilot'), 'what can you do?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      listeners.chunk.forEach((listener) =>
        listener({
          requestId: 'request-1',
          messageId: 'assistant-1',
          content:
            'I can help.\n\n| Tool | What it does |\n|---|---|\n| `listTools` | Lists tools |\n| `readRecord` | Reads the selected record |'
        })
      );
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tool' })).toBeInTheDocument();
    expect(screen.getByText('listTools', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('readRecord', { selector: 'code' })).toBeInTheDocument();
  });

  it('sends with Enter and preserves new lines with Shift+Enter', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    const input = await screen.findByLabelText('Message GitHub Copilot');
    await userEvent.type(input, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(input).toHaveValue('line one\nline two');
    expect(api.startChat).not.toHaveBeenCalled();

    await userEvent.type(input, '{Enter}');
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'line one\nline two'));
    expect(input).toHaveValue('');
  });

  it('shows progress before tokens stream and keeps new chat activity visible', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    let resolveStart: (value: { requestId: string; messageId: string }) => void = () => undefined;
    vi.mocked(api.startChat).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );

    render(<App />);
    const messages = await screen.findByRole('region', { name: 'Chat messages' });
    Object.defineProperty(messages, 'scrollHeight', { value: 500, configurable: true });
    messages.scrollTop = 0;

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'slow answer');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const working = await screen.findByText('Working');
    expect(working.closest('article')).toHaveClass('pending');
    await waitFor(() => expect(messages.scrollTop).toBe(500));

    act(() => {
      resolveStart({ requestId: 'request-1', messageId: 'assistant-1' });
    });
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'slow answer'));
  });

  it('preserves chat history across project changes and clears it only on request', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: []
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.type(await screen.findByLabelText('Message GitHub Copilot'), 'remember this');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'Kept history' }));
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    expect(await screen.findByText('Kept history')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Current project'), 'sample-project');
    expect(await screen.findByText('sample-project records')).toBeInTheDocument();
    expect(screen.getByText('remember this')).toBeInTheDocument();
    expect(screen.getByText('Kept history')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat messages' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('remember this')).not.toBeInTheDocument();
    expect(screen.queryByText('Kept history')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat messages are not persisted.')).not.toBeInTheDocument();
  });

  it('cancels in-progress streamed responses', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: []
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });
    vi.mocked(api.cancelChat).mockResolvedValue({ requestId: 'request-1', canceled: true });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.type(await screen.findByLabelText('Message GitHub Copilot'), 'slow-cancel');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => {
      listeners.canceled.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });

    expect(api.cancelChat).toHaveBeenCalledWith('request-1');
    const canceledMessage = await screen.findByText('Response canceled.');
    expect(canceledMessage.closest('article')).toHaveClass('assistant');
    expect(canceledMessage.closest('article')).not.toHaveClass('system');
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
  });

  it('refreshes the current project record list', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject)
      .mockResolvedValueOnce({
        project: { id: 'sample-project', name: 'sample-project' },
        projectConfig: {},
        schema: {},
        records: [{ id: 'valid-record', displayName: 'valid-record' }]
      })
      .mockResolvedValueOnce({
        project: { id: 'sample-project', name: 'sample-project' },
        projectConfig: {},
        schema: {},
        records: [
          { id: 'valid-record', displayName: 'valid-record' },
          { id: 'new-record', displayName: 'new-record' }
        ]
      });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    expect(await screen.findByRole('button', { name: 'valid-record' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh records' }));

    await waitFor(() => expect(api.openProject).toHaveBeenCalledTimes(2));
    expect(api.openProject).toHaveBeenLastCalledWith('sample-project');
    expect(await screen.findByRole('button', { name: 'new-record' })).toBeInTheDocument();
  });

  it('creates a project and opens it', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.createProject).mockResolvedValue({ id: 'new-project', name: 'new-project' });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'new-project', name: 'new-project' },
      projectConfig: {},
      schema: { type: 'object' },
      records: []
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('dialog', { name: 'Create project' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Project name'), 'new-project');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('new-project'));
    await waitFor(() => expect(screen.getByLabelText('Current project')).toHaveValue('new-project'));
    expect(await screen.findByText('new-project records')).toBeInTheDocument();
  });

  it('hides empty unconfigured feedback when USERNAME is missing', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      records: [{ id: 'valid-record', displayName: 'valid-record' }],
      feedbackConfig: {
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'none', comments: false, editable: false }
        }
      }
    });
    vi.mocked(api.getProjectUser).mockResolvedValue({
      valid: false,
      validationMessage: 'USERNAME environment variable not configured. Please set USERNAME in your .env file.'
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { answer: 'Run npm run check.' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [{ kind: 'value', label: 'answer', path: '/answer', value: 'Run npm run check.', validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    expect(await screen.findByText('Run npm run check.')).toBeInTheDocument();
    expect(screen.queryByLabelText('answer feedback')).not.toBeInTheDocument();
    expect(screen.queryByText('No feedback configured')).not.toBeInTheDocument();
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your .env file.')).not.toBeInTheDocument();
    expect(screen.queryByText('History (0)')).not.toBeInTheDocument();
  });

  it('configures feedback, submits, and toggles history', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'none' as const, comments: false, editable: false },
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', supportsEdit: false, feedback: 'none' as const, comments: false, editable: false },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', supportsEdit: true, feedback: 'none' as const, comments: false, editable: false }
      }
    };
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }
        }
      },
      records: [{ id: 'valid-record', displayName: 'valid-record' }],
      feedbackConfig
    });
    vi.mocked(api.getProjectUser).mockResolvedValue({ username: 'sme@example.com', valid: true });
    const submittedAt = new Date(Date.now() - 60000).toISOString();
    vi.mocked(api.getRecord)
      .mockResolvedValueOnce({
        projectId: 'sample-project',
        recordId: 'valid-record',
        displayName: 'valid-record',
        data: { answer: 'Run npm run check.' },
        schema: {},
        validationIssues: [],
        renderTree: {
          kind: 'object',
          label: 'record',
          path: '',
          children: [{ kind: 'value', label: 'answer', path: '/answer', value: 'Run npm run check.', validationIssues: [] }],
          validationIssues: []
        },
        feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
      })
      .mockResolvedValue({
        projectId: 'sample-project',
        recordId: 'valid-record',
        displayName: 'valid-record',
        data: { answer: 'Run npm run check.' },
        schema: {},
        validationIssues: [],
        renderTree: {
          kind: 'object',
          label: 'record',
          path: '',
          children: [{ kind: 'value', label: 'answer', path: '/answer', value: 'Run npm run check.', validationIssues: [] }],
          validationIssues: []
        },
        feedbackHistory: {
          '/answer': {
            feedback: [{ value: 'good', username: 'sme@example.com', timestamp: submittedAt }],
            comments: [{ value: 'Looks right', username: 'sme@example.com', timestamp: submittedAt }],
            edits: []
          }
        }
      });
    vi.mocked(api.saveFeedbackConfig).mockImplementation(async (_projectId, config) => config);
    vi.mocked(api.submitFeedback).mockImplementation(async () => ({
      username: 'sme@example.com',
      record: await api.getRecord('sample-project', 'valid-record')
    }));

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    expect(await screen.findByRole('dialog', { name: 'Feedback configuration' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'TAB' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Evidence feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence > Id feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence editable')).toBeDisabled();
    expect(screen.getByLabelText('Evidence > Id editable')).not.toBeDisabled();
    expect(screen.queryByRole('option', { name: 'text_only' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Answer feedback mode'), 'good_fair_bad');
    await userEvent.click(screen.getByLabelText('Answer comment'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveFeedbackConfig).toHaveBeenCalledWith(
        'sample-project',
        expect.objectContaining({
          properties: expect.objectContaining({
            '/answer': expect.objectContaining({ feedback: 'good_fair_bad', comments: true })
          })
        })
      )
    );

    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    expect(await screen.findByText('Run npm run check.')).toBeInTheDocument();
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your .env file.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeDisabled();
    expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com');
    expect(screen.queryByText(/Feedback mode:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await userEvent.type(screen.getByLabelText('Comment'), 'Looks right');
    await userEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalledWith('sample-project', 'valid-record', expect.objectContaining({ propertyPath: '/answer' })));

    const historySummary = await screen.findByText('History (1)');
    await userEvent.click(historySummary);
    expect(screen.getByText('feedback:').closest('.history-line')).toHaveTextContent('feedback:good');
    expect(screen.getByText('comment:').closest('.history-line')).toHaveTextContent('comment:Looks right');
    expect(screen.getAllByText('good').find((element) => element.closest('.history-entry'))).toBeVisible();
    expect(screen.getByText('Looks right')).toBeVisible();
    expect(screen.getAllByText(/ago|just now/).length).toBeGreaterThan(0);
  });

  it('renders schema descriptions inline, enum values as drop-downs, and array objects collapsed with counts', async () => {
    const node: RenderNode = {
      kind: 'object',
      label: 'record',
      children: [
        {
          kind: 'value',
          label: 'persona',
          description: 'The persona that might ask this question.',
          value: 'developer',
          enumValues: ['TPM', 'developer', 'SME'],
          validationIssues: []
        },
        {
          kind: 'array',
          label: 'evidence',
          description: 'The evidence that was found to support the answer.',
          items: [
            {
              kind: 'object',
              label: '0',
              children: [
                { kind: 'value', label: 'id', value: 'doc-1', validationIssues: [] },
                { kind: 'value', label: 'source', value: 'README', validationIssues: [] }
              ],
              validationIssues: []
            },
            {
              kind: 'object',
              label: '1',
              children: [
                { kind: 'value', label: 'id', value: 'doc-2', validationIssues: [] },
                { kind: 'value', label: 'source', value: 'runbook', validationIssues: [] }
              ],
              validationIssues: []
            }
          ],
          validationIssues: []
        }
      ],
      validationIssues: []
    };

    render(<RenderTree node={node} />);

    const personaHeading = screen.getByRole('heading', { name: 'persona The persona that might ask this question.' });
    expect(personaHeading).toBeInTheDocument();
    expect(screen.getByLabelText('persona')).toHaveDisplayValue('developer');
    expect(screen.getByText('evidence')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('doc-1', { selector: '.array-item-identifier' })).toBeVisible();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.getByText('README')).not.toBeVisible();

    await userEvent.click(screen.getByText('doc-1', { selector: '.array-item-identifier' }));
    expect(screen.getByText('README')).toBeVisible();
  });

  it('renders editable enum feedback as a drop-down', async () => {
    const node: RenderNode = {
      kind: 'value',
      label: 'persona',
      path: '/persona',
      value: 'developer',
      enumValues: ['TPM', 'developer', 'SME'],
      validationIssues: []
    };
    const submit = vi.fn().mockResolvedValue(undefined);

    render(
      <RenderTree
        node={node}
        feedbackConfig={{
          properties: {
            '/persona': {
              path: '/persona',
              target: 'Persona',
              tab: 'Main',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editable: true
            }
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={submit}
      />
    );

    expect(screen.getByLabelText('Edit')).toHaveDisplayValue('developer');
    expect(screen.queryByRole('option', { name: 'Choose edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Edit'), 'SME');
    await userEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ propertyPath: '/persona', editValue: 'SME' }));
  });

  it('uses the stored current value and shows the stored original value in history', async () => {
    const node: RenderNode = {
      kind: 'value',
      label: 'persona',
      path: '/persona',
      value: 'SME',
      enumValues: ['TPM', 'developer', 'SME'],
      validationIssues: []
    };

    render(
      <RenderTree
        node={node}
        feedbackConfig={{
          properties: {
            '/persona': {
              path: '/persona',
              target: 'Persona',
              tab: 'Main',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editable: true
            }
          }
        }}
        history={{
          '/persona': {
            feedback: [],
            comments: [],
            edits: [
              { value: 'TPM', username: 'sme@example.com', timestamp: '2026-06-01T20:00:00.000Z' },
              { value: 'SME', username: 'sme@example.com', timestamp: '2026-06-01T20:01:00.000Z' }
            ],
            original: 'developer'
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByLabelText('persona')).toHaveDisplayValue('SME');
    expect(screen.getByLabelText('persona')).not.toHaveClass('edited-value');
    expect(screen.getByLabelText('Edit')).toHaveDisplayValue('SME');
    expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeDisabled();

    const historySummary = screen.getByText('History (3)');
    await userEvent.click(historySummary);
    const historyLines = screen.getAllByText(/^(original:|edit:)$/).map((element) => element.closest('.history-line')?.textContent);
    expect(historyLines).toEqual(['edit:SME', 'edit:TPM', 'original:developer']);
  });

  it('supports keyboard-accessible column resizing', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });

    render(<App />);

    await screen.findByLabelText('Current project');
    const workspace = screen.getByRole('main', { name: 'Review workspace' });
    const initialColumns = workspace.getAttribute('style');
    const resizer = screen.getByRole('separator', { name: 'Resize records and details columns' });

    resizer.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(workspace.getAttribute('style')).not.toBe(initialColumns);
  });
});
