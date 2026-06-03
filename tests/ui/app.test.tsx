import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  closeRequested: (() => void)[];
};

const listeners: ListenerMap = {
  chunk: [],
  complete: [],
  error: [],
  canceled: [],
  loginComplete: [],
  closeRequested: []
};

const api: Api = {
  getBootstrap: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  openProject: vi.fn(),
  createRecordDraft: vi.fn(),
  getRecord: vi.fn(),
  updateRecordData: vi.fn(),
  getRecordDraftStatus: vi.fn(),
  saveRecordChanges: vi.fn(),
  discardRecordChanges: vi.fn(),
  getFeedbackConfig: vi.fn(),
  saveFeedbackConfig: vi.fn(),
  getProjectUser: vi.fn(),
  submitFeedback: vi.fn(),
  getAgentStatus: vi.fn(),
  continueWithGitHub: vi.fn(),
  startChat: vi.fn(),
  selectChatAttachments: vi.fn(),
  discardChatAttachment: vi.fn(),
  closeWindow: vi.fn(),
  cancelChat: vi.fn(),
  onCloseRequested: vi.fn((listener) => {
    listeners.closeRequested.push(listener);
    return () => {
      listeners.closeRequested = listeners.closeRequested.filter((item) => item !== listener);
    };
  }),
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
  listeners.closeRequested = [];
  vi.mocked(api.getAgentStatus).mockResolvedValue({
    provider: { id: 'github-copilot', name: 'GitHub Copilot' },
    availability: 'ready'
  });
  vi.mocked(api.getProjectUser).mockResolvedValue({ username: 'sme@example.com', valid: true });
  vi.mocked(api.getRecordDraftStatus).mockResolvedValue({ hasUnsavedChanges: false });
  vi.mocked(api.updateRecordData).mockImplementation(async (projectId, recordId, data) => ({
    projectId,
    recordId,
    displayName: recordId,
    data,
    schema: {},
    validationIssues: [],
    renderTree: { kind: 'object', label: 'record', path: '', children: [], validationIssues: [] }
  }));
  vi.mocked(api.saveRecordChanges).mockImplementation(async (projectId, recordId) => api.getRecord(projectId, recordId));
  vi.mocked(api.discardRecordChanges).mockResolvedValue({ hasUnsavedChanges: false });
  vi.mocked(api.saveFeedbackConfig).mockImplementation(async (_projectId, config) => config);
  vi.mocked(api.closeWindow).mockResolvedValue(undefined);
  vi.mocked(api.continueWithGitHub).mockResolvedValue({
    opened: true,
    loginId: 'login-1',
    deviceCode: '1234-ABCD',
    verificationUri: 'https://github.com/login/device',
    copiedToClipboard: true
  });
  vi.mocked(api.selectChatAttachments).mockResolvedValue({ attachments: [] });
  vi.mocked(api.discardChatAttachment).mockResolvedValue(undefined);
  window.reviewAssistant = api;
});

const getRecordCreateButton = (): HTMLElement => {
  const button = screen.getByRole('button', { name: 'Create record' });
  if (!button) {
    throw new Error('Record Create button not found.');
  }
  return button as HTMLElement;
};

const findRecordCreateButton = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(getRecordCreateButton()).toBeEnabled());
  return getRecordCreateButton();
};

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

  it('renders evidence lists compactly with editable and read-only indicators', async () => {
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
            '/turns/*/evidence/*': {
              path: '/turns/*/evidence/*',
              target: 'Evidence > *',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'thumbs',
              comments: false,
              editMode: 'none'
            },
            '/turns/*/evidence/*/id': {
              path: '/turns/*/evidence/*/id',
              target: 'Evidence > Id',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editMode: 'none'
            },
            '/turns/*/evidence/*/content': {
              path: '/turns/*/evidence/*/content',
              target: 'Evidence > Content',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'none',
              comments: true,
              editMode: 'logged'
            }
          }
        }}
        history={{
          '/turns/0/evidence/0': {
            feedback: [
              { value: 'thumbs_down', username: 'sme@example.com', timestamp: '2026-06-01T20:02:00.000Z' },
              { value: 'thumbs_up', username: 'sme@example.com', timestamp: '2026-06-01T20:01:00.000Z' }
            ],
            comments: [],
            edits: []
          }
        }}
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
    expect(screen.getByText('Logged')).toBeInTheDocument();
    expect(screen.getByLabelText('Architecture Notes feedback')).toBeInTheDocument();
    expect(screen.getByLabelText('Architecture Notes feedback value')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Architecture Notes' }).closest('summary')).toHaveAccessibleName(
      'Architecture Notes Feedback ratings: thumbs down, thumbs up doc-1'
    );
    expect(screen.getByRole('heading', { name: 'Architecture Notes' }).closest('summary')?.querySelector('.history-rating-summary')?.textContent).toBe('👎,👍');
    const contentFeedback = screen.getByLabelText('content feedback');
    expect(contentFeedback).toBeInTheDocument();
    expect(contentFeedback.textContent?.indexOf('Edit')).toBeLessThan(contentFeedback.textContent?.indexOf('Comment') ?? 0);
    expect(screen.queryByLabelText('id feedback')).not.toBeInTheDocument();
    const editableField = screen.getByText('content').closest('.evidence-field');
    expect(editableField).not.toBeNull();
    const editInput = within(editableField as HTMLElement).getByLabelText('Edit');
    await userEvent.clear(editInput);
    await userEvent.type(editInput, 'Edited evidence content');
    expect(within(editableField as HTMLElement).getByLabelText('Edit')).toHaveValue('Edited evidence content');
    expect(onSubmitFeedback).not.toHaveBeenCalled();
  });

  it('renders whole-item feedback controls for generic array object items', () => {
    const onSubmitFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'evidence',
          path: '/turns/0/evidence',
          items: [
            {
              kind: 'object',
              label: '0',
              path: '/turns/0/evidence/0',
              children: [
                { kind: 'value', label: 'id', path: '/turns/0/evidence/0/id', value: 'arch-order-001', validationIssues: [] },
                { kind: 'value', label: 'source', path: '/turns/0/evidence/0/source', value: 'Order Management Architecture', validationIssues: [] },
                { kind: 'value', label: 'content', path: '/turns/0/evidence/0/content', value: 'The architecture separates request handling.', validationIssues: [] }
              ],
              validationIssues: []
            }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/turns/*/evidence/*': {
              path: '/turns/*/evidence/*',
              target: 'Evidence > *',
              tab: 'Evidence',
              supportsEdit: true,
              feedback: 'thumbs',
              comments: false,
              editMode: 'none'
            }
          }
        }}
        history={{
          '/turns/0/evidence/0': {
            feedback: [
              { value: '5', username: 'sme@example.com', timestamp: '2026-06-01T20:02:00.000Z' },
              { value: '2', username: 'sme@example.com', timestamp: '2026-06-01T20:01:00.000Z' }
            ],
            comments: [],
            edits: []
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={onSubmitFeedback}
      />
    );

    expect(screen.getByText('arch-order-001', { selector: '.array-item-identifier' })).toBeInTheDocument();
    expect(screen.getByLabelText('arch-order-001 feedback')).toBeInTheDocument();
    expect(screen.getByLabelText('arch-order-001 feedback value')).toBeInTheDocument();
    const summary = screen.getByText('arch-order-001', { selector: '.array-item-identifier' }).closest('summary');
    expect(summary).toHaveAccessibleName('arch-order-001 Feedback ratings: 5 stars, 2 stars');
    expect(summary?.querySelector('.history-rating-summary')?.textContent).toBe('★★★★★,★★');
  });

  it('shows pending ratings on collapsed object sections without adding them to history', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [{ id: 'valid-record', displayName: 'valid-record' }],
      feedbackConfig: {
        properties: {
          '/evidence/*': {
            path: '/evidence/*',
            target: 'Evidence > *',
            tab: 'Main',
            supportsEdit: true,
            feedback: 'thumbs',
            comments: false,
            editMode: 'none'
          }
        }
      }
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { evidence: [{ id: 'doc-1', text: 'Relevant evidence' }] },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [
          {
            kind: 'array',
            label: 'evidence',
            path: '/evidence',
            items: [
              {
                kind: 'object',
                label: '0',
                path: '/evidence/0',
                children: [
                  { kind: 'value', label: 'id', path: '/evidence/0/id', value: 'doc-1', validationIssues: [] },
                  { kind: 'value', label: 'text', path: '/evidence/0/text', value: 'Relevant evidence', validationIssues: [] }
                ],
                validationIssues: []
              }
            ],
            validationIssues: []
          }
        ],
        validationIssues: []
      },
      feedbackHistory: { '/evidence/0': { feedback: [], edits: [], comments: [] } }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    await userEvent.click(await screen.findByRole('radio', { name: '👍' }));

    const summary = screen.getByText('doc-1', { selector: '.array-item-identifier' }).closest('summary');
    expect(summary).toHaveAccessibleName('doc-1 Feedback ratings: thumbs up');
    expect(summary?.querySelector('.history-rating-summary')?.textContent).toBe('👍');
    expect(screen.queryByText('History (1)')).not.toBeInTheDocument();
    expect(api.submitFeedback).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('radio', { name: '👍' }));

    expect(summary).toHaveAccessibleName('doc-1');
    expect(summary?.querySelector('.history-rating-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.submitFeedback).not.toHaveBeenCalled();
  });

  it('shows submitted ratings in the collapsed history summary', () => {
    render(
      <RenderTree
        node={{
          kind: 'value',
          label: 'answer',
          path: '/answer',
          value: 'Use the documented harness.',
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/answer': {
              path: '/answer',
              target: 'Answer',
              tab: 'Main',
              supportsEdit: true,
              feedback: 'thumbs',
              comments: true,
              editMode: 'none'
            }
          }
        }}
        history={{
          '/answer': {
            feedback: [
              { value: '5', username: 'sme@example.com', timestamp: '2026-06-01T20:02:00.000Z' },
              { value: '2', username: 'sme@example.com', timestamp: '2026-06-01T20:01:00.000Z' },
              { value: '4', username: 'sme@example.com', timestamp: '2026-06-01T20:00:00.000Z' }
            ],
            comments: [],
            edits: []
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const summary = screen.getByText('History (3)').closest('summary');
    expect(summary).toHaveAccessibleName('History (3) Feedback ratings: 5 stars, 2 stars, 4 stars');
    const ratings = summary ? [...summary.querySelectorAll('.history-rating')].map((element) => element.textContent) : [];
    expect(ratings).toEqual(['★★★★★', '★★', '★★★★']);
    expect(summary?.querySelector('.history-rating-summary')?.textContent).toBe('★★★★★,★★,★★★★');
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
    await screen.findByLabelText('Current project');
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    const createProjectButton = within(screen.getByRole('banner')).getByRole('button', { name: 'Create project' });
    expect(createProjectButton).toHaveClass('header-action-button', 'action-icon-button');
    expect(createProjectButton).toHaveAttribute('data-tooltip', 'Create project');
    expect(document.querySelector('.create-record-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh records' })).not.toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await waitFor(() => expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com'));
    expect(await screen.findByRole('button', { name: 'Configure' })).toBeInTheDocument();
    const configureButton = within(screen.getByRole('banner')).getByRole('button', { name: 'Configure' });
    expect(configureButton).toHaveClass('header-action-button', 'action-icon-button');
    expect(configureButton).toHaveAttribute('data-tooltip', 'Configure feedback');
    const createRecordButton = getRecordCreateButton();
    const refreshRecordsButton = screen.getByRole('button', { name: 'Refresh records' });
    expect(createRecordButton).toBeEnabled();
    expect(refreshRecordsButton).toBeEnabled();
    expect(createRecordButton).toHaveClass('action-icon-button');
    expect(createRecordButton).toHaveAttribute('data-tooltip', 'Create record');
    expect(refreshRecordsButton).toHaveClass('action-icon-button');
    expect(refreshRecordsButton).toHaveAttribute('data-tooltip', 'Refresh records');
    expect(createRecordButton.parentElement).toBe(refreshRecordsButton.parentElement);
    const recordList = await screen.findByRole('region', { name: 'Records list' });
    const recordButton = await screen.findByRole('button', { name: 'valid-record' });
    expect(recordList).toContainElement(recordButton);
    await userEvent.click(recordButton);
    expect(await screen.findByText('Record passes schema validation.')).toBeInTheDocument();
    const saveRecordButton = screen.getByRole('button', { name: 'Save' });
    expect(saveRecordButton).toHaveClass('create-record-button', 'action-icon-button');
    expect(saveRecordButton).toHaveAttribute('data-tooltip', 'Save record');
    expect(saveRecordButton.querySelector('.action-svg-icon')).not.toBeNull();
    expect(saveRecordButton).not.toHaveClass('create-project-button');
    expect(screen.queryByRole('heading', { name: 'record' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'question' })).toBeInTheDocument();
    expect(screen.getByText('How?')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'hello', [], []));
    act(() => {
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'Streamed ' }));
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'response' }));
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    expect(await screen.findByText('Streamed response')).toBeInTheDocument();
  });

  it('hides fields not in the schema by default and toggles them from record details', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      records: [{ id: 'valid-record', displayName: 'valid-record' }]
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { answer: 'Use the harness.', extra: 'Here is some extra stuff' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [
          { kind: 'value', label: 'answer', path: '/answer', value: 'Use the harness.', validationIssues: [] },
          {
            kind: 'raw',
            label: 'extra',
            path: '/extra',
            value: 'Here is some extra stuff',
            reason: 'Field is present in data but not declared by schema.',
            validationIssues: []
          }
        ],
        validationIssues: []
      }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));

    expect(await screen.findByText('Use the harness.')).toBeInTheDocument();
    expect(screen.getByLabelText('Show fields not in schema')).not.toBeChecked();
    expect(screen.queryByRole('heading', { name: 'extra (not in schema)' })).not.toBeInTheDocument();
    expect(screen.queryByText('"Here is some extra stuff"')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show fields not in schema'));

    expect(screen.getByRole('heading', { name: 'extra (not in schema)' })).toBeInTheDocument();
    expect(screen.getByText('"Here is some extra stuff"')).toBeInTheDocument();
    expect(screen.queryByText('Field is present in data but not declared by schema.')).not.toBeInTheDocument();
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

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'who is the persona?', [], []));
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
    const loginButton = screen.getByRole('button', { name: 'Login to GitHub' });
    expect(loginButton).toHaveClass('github-login-button', 'chat-login-button', 'action-icon-button');
    expect(loginButton).toHaveAttribute('data-tooltip', 'Login to GitHub');
    expect(loginButton).toHaveAttribute('data-tooltip-align', 'left');
    expect(loginButton.parentElement).toHaveClass('chat-login-actions');
    expect(loginButton.parentElement?.nextElementSibling).toHaveClass('chat-actions');
    expect(screen.getByRole('button', { name: 'Attach' })).toHaveClass('action-icon-button');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('action-icon-button');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveTextContent('↵');
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveClass('action-icon-button');
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveTextContent('CLR');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('action-icon-button');
    expect(screen.getByRole('button', { name: 'Attach' })).toHaveAttribute('data-tooltip', 'Attach files');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-tooltip', 'Send message');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-tooltip-align', 'right');
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

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'general question', [], []));
  });

  it('attaches selected text files to the next chat request', async () => {
    const attachment = {
      id: 'attachment-1',
      name: 'notes.md',
      path: '/Users/sme/notes.md',
      sizeBytes: 2048
    };
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.selectChatAttachments).mockResolvedValue({ attachments: [attachment] });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await screen.findByLabelText('Message GitHub Copilot');
    await userEvent.click(screen.getByRole('button', { name: 'Attach' }));

    expect(api.selectChatAttachments).toHaveBeenCalledOnce();
    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'use this context');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'use this context', [], [attachment]));
    expect(screen.getByText('Attached files:')).toBeInTheDocument();
    expect(screen.queryByLabelText('Selected chat attachments')).not.toBeInTheDocument();
  });

  it('discards attachment content from main when an attachment chip is removed', async () => {
    const attachment = {
      id: 'attachment-1',
      name: 'notes.md',
      path: '/Users/sme/notes.md',
      sizeBytes: 128
    };
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.selectChatAttachments).mockResolvedValue({ attachments: [attachment] });

    render(<App />);
    await screen.findByLabelText('Message GitHub Copilot');
    await userEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(await screen.findByText('notes.md')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));

    await waitFor(() => expect(api.discardChatAttachment).toHaveBeenCalledWith('attachment-1'));
    expect(screen.queryByLabelText('Selected chat attachments')).not.toBeInTheDocument();
  });

  it('refreshes project feedback configuration after an agent updates the project schema', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject)
      .mockResolvedValueOnce({
        project: { id: 'sample-project', name: 'sample-project' },
        projectConfig: {},
        schema: { type: 'object', properties: {} },
        records: [],
        feedbackConfig: { properties: {} }
      })
      .mockResolvedValueOnce({
        project: { id: 'sample-project', name: 'sample-project' },
        projectConfig: {},
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
        records: [],
        feedbackConfig: {
          properties: {
            '/answer': {
              path: '/answer',
              target: 'Answer',
              tab: 'Main',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editMode: 'none'
            }
          }
        }
      });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await screen.findByText('No records loaded.');

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'generate a schema from the attachment');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', undefined, 'generate a schema from the attachment', [], []));
    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });

    await waitFor(() => expect(api.openProject).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(await screen.findByRole('dialog', { name: 'Feedback configuration' })).toBeVisible();
    expect(screen.getByText('Answer')).toBeInTheDocument();
    expect(screen.getByLabelText('Answer feedback mode')).toBeInTheDocument();
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

  it('sends prior chat turns so follow-up save requests can reuse search context', async () => {
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
    vi.mocked(api.startChat)
      .mockResolvedValueOnce({ requestId: 'request-1', messageId: 'assistant-1' })
      .mockResolvedValueOnce({ requestId: 'request-2', messageId: 'assistant-2' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    await screen.findByText('How?');

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'search for "configuration management"');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(api.startChat).toHaveBeenNthCalledWith(1, 'sample-project', 'valid-record', 'search for "configuration management"', [], [])
    );
    act(() => {
      listeners.chunk.forEach((listener) =>
        listener({
          requestId: 'request-1',
          messageId: 'assistant-1',
          content: 'Found results: vinsol/nectarcommerce README.md and spryker/spryker-docs llms.txt.'
        })
      );
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    expect(await screen.findByText(/vinsol\/nectarcommerce/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'put them in turn 1 evidence');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText(/vinsol\/nectarcommerce/).closest('article')).not.toHaveClass('pending');
    expect((await screen.findByText('Working')).closest('article')).toHaveClass('pending');
    await waitFor(() =>
      expect(api.startChat).toHaveBeenNthCalledWith(
        2,
        'sample-project',
        'valid-record',
        'put them in turn 1 evidence',
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'search for "configuration management"' }),
          expect.objectContaining({ role: 'assistant', content: expect.stringContaining('vinsol/nectarcommerce') })
        ]),
        []
      )
    );
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
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'line one\nline two', [], []));
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
    expect(screen.getByRole('status')).toHaveTextContent('Agent is still running...');
    await waitFor(() => expect(messages.scrollTop).toBe(500));

    act(() => {
      resolveStart({ requestId: 'request-1', messageId: 'assistant-1' });
    });
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'slow answer', [], []));
    act(() => {
      listeners.chunk.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1', content: 'Partial answer' }));
    });
    expect(await screen.findByText('Partial answer')).toBeInTheDocument();
    expect(screen.getByText('Partial answer').closest('article')).toHaveClass('pending');
    expect(screen.getByRole('status')).toHaveTextContent('Agent is still running...');
    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('refreshes the selected record after an agent run completes', async () => {
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
    vi.mocked(api.getRecord)
      .mockResolvedValueOnce({
        projectId: 'sample-project',
        recordId: 'valid-record',
        displayName: 'valid-record',
        data: { answer: 'Before agent save' },
        schema: {},
        validationIssues: [],
        renderTree: {
          kind: 'object',
          label: 'record',
          children: [{ kind: 'value', label: 'answer', value: 'Before agent save', validationIssues: [] }],
          validationIssues: []
        }
      })
      .mockResolvedValueOnce({
        projectId: 'sample-project',
        recordId: 'valid-record',
        displayName: 'valid-record',
        data: { answer: 'After agent save' },
        schema: {},
        validationIssues: [],
        renderTree: {
          kind: 'object',
          label: 'record',
          children: [{ kind: 'value', label: 'answer', value: 'After agent save', validationIssues: [] }],
          validationIssues: []
        }
      });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    expect(await screen.findByText('Before agent save')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'put search results in evidence');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());

    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });

    await waitFor(() => expect(api.getRecord).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('After agent save')).toBeInTheDocument();
  });

  it('renders URL string fields as links in record details', async () => {
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
      data: { uri: 'https://github.com/n0xa/m5stick-nemo/blob/main/PLAN.md' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [
          {
            kind: 'value',
            label: 'uri',
            path: '/uri',
            value: 'https://github.com/n0xa/m5stick-nemo/blob/main/PLAN.md',
            validationIssues: []
          }
        ],
        validationIssues: []
      }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));

    expect(await screen.findByRole('link', { name: 'https://github.com/n0xa/m5stick-nemo/blob/main/PLAN.md' })).toHaveAttribute(
      'href',
      'https://github.com/n0xa/m5stick-nemo/blob/main/PLAN.md'
    );
  });

  it('renders clear validation messages without synthetic missing labels', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [{ id: 'draft-record', displayName: 'draft-record' }]
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'draft-record',
      displayName: 'draft-record',
      data: {},
      schema: {},
      validationIssues: [
        { path: '/', keyword: 'required', message: 'Missing required field: id' },
        { path: '/persona', keyword: 'enum', message: 'Value must be one of: TPM, developer, SME' }
      ],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [
          { kind: 'value', label: 'id', path: '/id', value: undefined, validationIssues: [] },
          {
            kind: 'value',
            label: 'persona',
            path: '/persona',
            value: undefined,
            enumValues: ['TPM', 'developer', 'SME'],
            validationIssues: [{ path: '/persona', keyword: 'enum', message: 'Value must be one of: TPM, developer, SME' }]
          }
        ],
        validationIssues: []
      }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'draft-record' }));

    expect(await screen.findByText('Record: Missing required field: id')).toBeInTheDocument();
    expect(screen.getAllByText('persona: Value must be one of: TPM, developer, SME').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\(missing\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(not allowed\)/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('persona') as HTMLSelectElement).options[0]?.text).toBe('');
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
    expect(await screen.findByRole('heading', { name: 'records' })).toBeInTheDocument();
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

  it('creates a new unsaved record and focuses it', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      records: [{ id: 'valid-record', displayName: 'valid-record' }]
    });
    vi.mocked(api.createRecordDraft).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'custom-record',
      displayName: 'custom-record',
      data: {},
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [],
        validationIssues: []
      }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());

    const dialog = await screen.findByRole('dialog', { name: 'Create record' });
    expect(within(dialog).queryByText('Enter the JSON filename for this record. The .json extension is optional.')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Filename')).toHaveValue('');
    await userEvent.type(within(dialog).getByLabelText('Filename'), 'custom-record.json');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(api.createRecordDraft).toHaveBeenCalledWith('sample-project', 'custom-record'));
    expect(await screen.findByRole('button', { name: 'custom-record' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(api.saveRecordChanges).not.toHaveBeenCalled();
  });

  it('keeps a draft-only record selected after an agent run refreshes project state', async () => {
    const schema = { type: 'object', properties: { history: { type: 'array', items: {} } } };
    const draftRecord = {
      projectId: 'sample-project',
      recordId: 'custom-record',
      displayName: 'custom-record',
      data: {},
      schema,
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        children: [{ kind: 'array' as const, label: 'history', path: '/history', items: [], validationIssues: [] }],
        validationIssues: []
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
      schema,
      records: [],
      feedbackConfig: { properties: {} }
    });
    vi.mocked(api.createRecordDraft).mockResolvedValue(draftRecord);
    vi.mocked(api.getRecord).mockResolvedValue({
      ...draftRecord,
      data: { history: [{ question: 'What is the system architecture of Order Management?' }] },
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        children: [
          {
            kind: 'array' as const,
            label: 'history',
            path: '/history',
            items: [
              {
                kind: 'object' as const,
                label: '0',
                path: '/history/0',
                children: [{ kind: 'value' as const, label: 'question', path: '/history/0/question', value: 'What is the system architecture of Order Management?', validationIssues: [] }],
                validationIssues: []
              }
            ],
            validationIssues: []
          }
        ],
        validationIssues: []
      }
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());
    await userEvent.type(within(await screen.findByRole('dialog', { name: 'Create record' })).getByLabelText('Filename'), 'custom-record.json');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Create record' })).getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByRole('button', { name: 'custom-record' })).toHaveClass('selected');

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'add a turn');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'custom-record', 'add a turn', [], []));
    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });

    expect(await screen.findByRole('button', { name: 'custom-record' })).toHaveClass('selected');
    await waitFor(() => expect(screen.getByRole('button', { name: 'custom-record' })).toHaveClass('selected'));
    expect(api.getRecord).toHaveBeenCalledWith('sample-project', 'custom-record');
  });

  it('stages inline edits for a new record so validation and save use the edited data', async () => {
    const schema = {
      type: 'object',
      required: ['id', 'persona', 'turns'],
      properties: {
        id: { type: 'string', description: 'Unique identifier for the record.' },
        persona: { type: 'string', enum: ['developer', 'admin'] },
        turns: { type: 'array', items: {} }
      }
    };
    const feedbackConfig = {
      properties: {
        '/id': { path: '/id', target: 'ID', tab: 'Record', supportsEdit: true, feedback: 'none' as const, comments: false, editMode: 'inline' as const },
        '/persona': {
          path: '/persona',
          target: 'Persona',
          tab: 'Record',
          supportsEdit: true,
          feedback: 'none' as const,
          comments: false,
          editMode: 'inline' as const
        },
        '/turns': { path: '/turns', target: 'Turns', tab: 'Record', supportsEdit: false, feedback: 'none' as const, comments: false, editMode: 'none' as const }
      }
    };
    const recordDetail = (data: Record<string, unknown>) => {
      const missingIssues = (['id', 'persona', 'turns'] as const)
        .filter((field) => data[field] === undefined)
        .map((field) => ({ path: '', message: `Missing required field: ${field}`, keyword: 'required' }));
      return {
        projectId: 'sample-project',
        recordId: 'q99',
        displayName: 'q99',
        data,
        schema,
        validationIssues: missingIssues,
        renderTree: {
          kind: 'object' as const,
          label: 'record',
          path: '',
          children: [
            { kind: 'value' as const, label: 'id', path: '/id', value: data.id, type: 'string', description: 'Unique identifier for the record.', validationIssues: [] },
            { kind: 'value' as const, label: 'persona', path: '/persona', value: data.persona, type: 'string', enumValues: ['developer', 'admin'], validationIssues: [] },
            { kind: 'array' as const, label: 'turns', path: '/turns', items: [], validationIssues: [] }
          ],
          validationIssues: missingIssues
        },
        feedbackHistory: {}
      };
    };
    let stagedData: Record<string, unknown> = {};
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema,
      records: [],
      feedbackConfig
    });
    vi.mocked(api.createRecordDraft).mockResolvedValue(recordDetail(stagedData));
    vi.mocked(api.updateRecordData).mockImplementation(async (_projectId, _recordId, data) => {
      stagedData = data as Record<string, unknown>;
      return recordDetail(stagedData);
    });
    vi.mocked(api.saveRecordChanges).mockImplementation(async () => recordDetail(stagedData));

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());
    await userEvent.type(within(await screen.findByRole('dialog', { name: 'Create record' })).getByLabelText('Filename'), 'q99.json');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Create record' })).getByRole('button', { name: /^Create$/ }));

    expect(await screen.findByText('Record: Missing required field: id')).toBeInTheDocument();
    expect(screen.getByLabelText('persona')).toHaveDisplayValue('(not set)');
    await userEvent.type(screen.getByLabelText('id'), 'q99');
    await userEvent.selectOptions(screen.getByLabelText('persona'), 'developer');

    await waitFor(() => expect(api.updateRecordData).toHaveBeenLastCalledWith('sample-project', 'q99', { id: 'q99', persona: 'developer' }));
    await waitFor(() => expect(screen.queryByText('Record: Missing required field: id')).not.toBeInTheDocument());
    expect(screen.queryByText('Record: Missing required field: persona')).not.toBeInTheDocument();
    expect(screen.getByText('Record: Missing required field: turns')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveRecordChanges).toHaveBeenCalledWith('sample-project', 'q99'));
    expect(stagedData).toEqual({ id: 'q99', persona: 'developer' });
  });

  it('serializes inline edit staging so older responses cannot overwrite newer draft data', async () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string' }
      }
    };
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Record', supportsEdit: true, feedback: 'none' as const, comments: false, editMode: 'inline' as const }
      }
    };
    const recordDetail = (answer: string) => ({
      projectId: 'sample-project',
      recordId: 'record-1',
      displayName: 'record-1',
      data: { answer },
      schema,
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [{ kind: 'value' as const, label: 'answer', path: '/answer', value: answer, type: 'string', validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: {}
    });
    const pendingUpdates: Array<{
      data: unknown;
      resolve: (record: ReturnType<typeof recordDetail>) => void;
    }> = [];
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema,
      records: [{ id: 'record-1', displayName: 'record-1' }],
      feedbackConfig
    });
    vi.mocked(api.getRecord).mockResolvedValue(recordDetail(''));
    vi.mocked(api.updateRecordData).mockImplementation(
      async (_projectId, _recordId, data) =>
        new Promise((resolve) => {
          pendingUpdates.push({ data, resolve });
        })
    );

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.type(await screen.findByLabelText('answer'), 'AB');

    await waitFor(() => expect(api.updateRecordData).toHaveBeenCalledTimes(1));
    expect(pendingUpdates[0].data).toEqual({ answer: 'A' });
    expect(api.updateRecordData).not.toHaveBeenCalledTimes(2);

    act(() => {
      pendingUpdates[0].resolve(recordDetail('A'));
    });
    await waitFor(() => expect(api.updateRecordData).toHaveBeenCalledTimes(2));
    expect(pendingUpdates[1].data).toEqual({ answer: 'AB' });

    act(() => {
      pendingUpdates[1].resolve(recordDetail('AB'));
    });
    await waitFor(() => expect(screen.getByLabelText('answer')).toHaveValue('AB'));
  });

  it('validates new record filenames before creating a draft', async () => {
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

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());
    const dialog = await screen.findByRole('dialog', { name: 'Create record' });

    await userEvent.clear(within(dialog).getByLabelText('Filename'));
    await userEvent.type(within(dialog).getByLabelText('Filename'), '../bad.json');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create$/ }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Filename cannot include path separators or "..".');
    expect(api.createRecordDraft).not.toHaveBeenCalled();
  });

  it('shows duplicate new record filenames inside the create record dialog', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [{ id: 'q01', displayName: 'q01' }]
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());
    const dialog = await screen.findByRole('dialog', { name: 'Create record' });
    await userEvent.type(within(dialog).getByLabelText('Filename'), 'q01.json');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create$/ }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Record already exists: q01.json');
    expect(api.createRecordDraft).not.toHaveBeenCalled();
    expect(screen.queryByText(/records:createDraft/)).not.toBeInTheDocument();
  });

  it('removes a discarded unsaved record from the list before creating another', async () => {
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
    vi.mocked(api.createRecordDraft).mockImplementation(async (_projectId, recordId) => ({
      projectId: 'sample-project',
      recordId,
      displayName: recordId,
      data: {},
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        children: [],
        validationIssues: []
      }
    }));
    vi.mocked(api.getRecordDraftStatus).mockImplementation(async (_projectId, recordId) => ({ hasUnsavedChanges: recordId === 'new-record' }));

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await findRecordCreateButton());
    let dialog = await screen.findByRole('dialog', { name: 'Create record' });
    await userEvent.type(within(dialog).getByLabelText('Filename'), 'new-record.json');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByRole('button', { name: 'new-record' })).toHaveClass('selected');

    await userEvent.click(getRecordCreateButton());
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(api.discardRecordChanges).toHaveBeenCalledWith('sample-project', 'new-record'));
    dialog = await screen.findByRole('dialog', { name: 'Create record' });
    expect(within(dialog).getByLabelText('Filename')).toHaveValue('');
    await userEvent.type(within(dialog).getByLabelText('Filename'), 'new-record.json');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(api.createRecordDraft).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('button', { name: 'new-record' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'new-record' })).toHaveClass('selected');
  });

  it('warns before refreshing records when the selected record has unsaved changes', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
      }
    };
    const recordDetail = {
      projectId: 'sample-project',
      recordId: 'record-1',
      displayName: 'record-1',
      data: { answer: 'First answer' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [{ kind: 'value' as const, label: 'answer', path: '/answer', value: 'First answer', validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
    };
    let hasDraft = false;
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
        records: [{ id: 'record-1', displayName: 'record-1' }],
        feedbackConfig
      })
      .mockResolvedValue({
        project: { id: 'sample-project', name: 'sample-project' },
        projectConfig: {},
        schema: {},
        records: [],
        feedbackConfig
      });
    vi.mocked(api.getRecord).mockResolvedValue(recordDetail);
    vi.mocked(api.getRecordDraftStatus).mockImplementation(async () => ({ hasUnsavedChanges: hasDraft }));
    vi.mocked(api.submitFeedback).mockImplementation(async () => {
      hasDraft = true;
      return { username: 'sme@example.com', record: recordDetail };
    });
    vi.mocked(api.discardRecordChanges).mockImplementation(async () => {
      hasDraft = false;
      return { hasUnsavedChanges: false };
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(api.submitFeedback).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh records' }));

    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    expect(api.openProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText('First answer')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(api.discardRecordChanges).toHaveBeenCalledWith('sample-project', 'record-1'));
    await waitFor(() => expect(api.openProject).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('First answer')).not.toBeInTheDocument();
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
    await userEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('dialog', { name: 'Create project' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Project name'), 'new-project');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Create project' })).getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('new-project'));
    await waitFor(() => expect(screen.getByLabelText('Current project')).toHaveValue('new-project'));
    expect(await screen.findByRole('heading', { name: 'records' })).toBeInTheDocument();
  });

  it('warns before opening a newly created project with unsaved changes', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
      }
    };
    const recordDetail = {
      projectId: 'sample-project',
      recordId: 'record-1',
      displayName: 'record-1',
      data: { answer: 'First answer' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [{ kind: 'value' as const, label: 'answer', path: '/answer', value: 'First answer', validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
    };
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockImplementation(async (projectId) => ({
      project: { id: projectId, name: projectId },
      projectConfig: {},
      schema: {},
      records: projectId === 'new-project' ? [] : [{ id: 'record-1', displayName: 'record-1' }],
      feedbackConfig
    }));
    vi.mocked(api.getRecord).mockResolvedValue(recordDetail);
    let hasDraft = false;
    vi.mocked(api.getRecordDraftStatus).mockImplementation(async () => ({ hasUnsavedChanges: hasDraft }));
    vi.mocked(api.submitFeedback).mockImplementation(async () => {
      hasDraft = true;
      return { username: 'sme@example.com', record: recordDetail };
    });
    vi.mocked(api.discardRecordChanges).mockImplementation(async () => {
      hasDraft = false;
      return { hasUnsavedChanges: false };
    });
    vi.mocked(api.createProject).mockResolvedValue({ id: 'new-project', name: 'new-project' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(api.submitFeedback).not.toHaveBeenCalled();

    await userEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Create project' }));
    await userEvent.type(await screen.findByLabelText('Project name'), 'new-project');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Create project' })).getByRole('button', { name: /^Create$/ }));

    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    expect(screen.getByLabelText('Current project')).toHaveValue('sample-project');
    expect(api.createProject).not.toHaveBeenCalled();
    expect(vi.mocked(api.openProject).mock.calls.some(([projectId]) => projectId === 'new-project')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(api.discardRecordChanges).toHaveBeenCalledWith('sample-project', 'record-1'));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('new-project'));
    await waitFor(() => expect(api.openProject).toHaveBeenCalledWith('new-project'));
    expect(await screen.findByLabelText('Current project')).toHaveValue('new-project');
    expect(await screen.findByRole('heading', { name: 'records' })).toBeInTheDocument();
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
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'none', comments: false, editMode: 'none' }
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
    expect(await screen.findByText('Run npm run check.', { selector: 'output' })).toBeInTheDocument();
    expect(screen.queryByLabelText('answer feedback')).not.toBeInTheDocument();
    expect(screen.queryByText('No feedback configured')).not.toBeInTheDocument();
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your .env file.')).not.toBeInTheDocument();
    expect(screen.queryByText('History (0)')).not.toBeInTheDocument();
  });

  it('applies saved feedback configuration to the currently displayed record', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'none' as const, comments: false, editMode: 'none' as const }
      }
    };
    const configuredFeedbackConfig = {
      properties: {
        '/answer': { ...feedbackConfig.properties['/answer'], feedback: 'good_fair_bad' as const, comments: true, editMode: 'logged' as const }
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
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      records: [{ id: 'valid-record', displayName: 'valid-record' }],
      feedbackConfig
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
    vi.mocked(api.saveFeedbackConfig).mockResolvedValue(configuredFeedbackConfig);

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    expect(await screen.findByText('Run npm run check.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stage feedback' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));
    await userEvent.selectOptions(await screen.findByLabelText('Answer feedback mode'), 'good_fair_bad');
    await userEvent.click(screen.getByLabelText('Answer comment'));
    await userEvent.selectOptions(screen.getByLabelText('Answer editable'), 'logged');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Feedback configuration' })).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveFeedbackConfig).toHaveBeenCalledWith('sample-project', configuredFeedbackConfig));
    expect(await screen.findByRole('radio', { name: 'Good' })).toBeInTheDocument();
    expect(screen.getByLabelText('Comment')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit')).toHaveDisplayValue('Run npm run check.');
    expect(screen.queryByRole('button', { name: 'Stage feedback' })).not.toBeInTheDocument();
    expect(api.getRecord).toHaveBeenCalledTimes(2);
  });

  it('configures feedback, submits, and toggles history', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'none' as const, comments: false, editMode: 'none' as const },
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', supportsEdit: false, feedback: 'none' as const, comments: false, editMode: 'none' as const },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', supportsEdit: true, feedback: 'none' as const, comments: false, editMode: 'none' as const }
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
    expect(screen.getByLabelText('Answer editable')).toHaveDisplayValue('none');
    expect(screen.queryByRole('option', { name: 'text_only' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Answer feedback mode'), 'good_fair_bad');
    await userEvent.selectOptions(screen.getByLabelText('Answer editable'), 'logged');
    await userEvent.click(screen.getByLabelText('Answer comment'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveFeedbackConfig).toHaveBeenCalledWith(
        'sample-project',
        expect.objectContaining({
          properties: expect.objectContaining({
            '/answer': expect.objectContaining({ feedback: 'good_fair_bad', comments: true, editMode: 'logged' })
          })
        })
      )
    );

    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));
    expect(await screen.findByText('Run npm run check.', { selector: 'output' })).toBeInTheDocument();
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your .env file.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com');
    expect(screen.queryByText(/Feedback mode:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await userEvent.type(screen.getByLabelText('Comment'), 'Looks right');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(api.submitFeedback).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalledWith('sample-project', 'valid-record', expect.objectContaining({ propertyPath: '/answer' })));
    await waitFor(() => expect(api.saveRecordChanges).toHaveBeenCalledWith('sample-project', 'valid-record'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());

    const historySummary = await screen.findByText('History (1)');
    await userEvent.click(historySummary);
    expect(screen.getByText('feedback:').closest('.history-line')).toHaveTextContent('feedback:good');
    expect(screen.getByText('comment:').closest('.history-line')).toHaveTextContent('comment:Looks right');
    expect(screen.getAllByText('good').find((element) => element.closest('.history-entry'))).toBeVisible();
    expect(screen.getByText('Looks right')).toBeVisible();
    expect(screen.getAllByText(/ago|just now/).length).toBeGreaterThan(0);
  });

  it('warns before closing or switching records with unsaved changes', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true, feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
      }
    };
    const recordDetail = (recordId: string, answer: string) => ({
      projectId: 'sample-project',
      recordId,
      displayName: recordId,
      data: { answer },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [{ kind: 'value' as const, label: 'answer', path: '/answer', value: answer, validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
    });
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [
        { id: 'record-1', displayName: 'record-1' },
        { id: 'record-2', displayName: 'record-2' }
      ],
      feedbackConfig
    });
    vi.mocked(api.getRecord).mockImplementation(async (_projectId, recordId) =>
      recordId === 'record-2' ? recordDetail('record-2', 'Second answer') : recordDetail('record-1', 'First answer')
    );
    let hasDraft = false;
    vi.mocked(api.getRecordDraftStatus).mockImplementation(async () => ({ hasUnsavedChanges: hasDraft }));
    vi.mocked(api.submitFeedback).mockImplementation(async () => {
      hasDraft = true;
      return { username: 'sme@example.com', record: recordDetail('record-1', 'First answer') };
    });
    vi.mocked(api.discardRecordChanges).mockImplementation(async () => {
      hasDraft = false;
      return { hasUnsavedChanges: false };
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(api.submitFeedback).not.toHaveBeenCalled();

    act(() => {
      listeners.closeRequested.forEach((listener) => listener());
    });
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(api.closeWindow).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'record-2' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(api.discardRecordChanges).toHaveBeenCalledWith('sample-project', 'record-1'));
    expect(await screen.findByText('Second answer')).toBeInTheDocument();
  });

  it('checks draft status before switching records while an agent response is still running', async () => {
    const recordDetail = (recordId: string, answer: string) => ({
      projectId: 'sample-project',
      recordId,
      displayName: recordId,
      data: { answer },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [{ kind: 'value' as const, label: 'answer', path: '/answer', value: answer, validationIssues: [] }],
        validationIssues: []
      },
      feedbackHistory: { '/answer': { feedback: [], edits: [], comments: [] } }
    });
    let hasDraft = false;
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test'
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [
        { id: 'record-1', displayName: 'record-1' },
        { id: 'record-2', displayName: 'record-2' }
      ]
    });
    vi.mocked(api.getRecord).mockImplementation(async (_projectId, recordId) =>
      recordId === 'record-2' ? recordDetail('record-2', 'Second answer') : recordDetail('record-1', 'First answer')
    );
    vi.mocked(api.getRecordDraftStatus).mockImplementation(async () => ({ hasUnsavedChanges: hasDraft }));
    vi.mocked(api.discardRecordChanges).mockImplementation(async () => {
      hasDraft = false;
      return { hasUnsavedChanges: false };
    });
    vi.mocked(api.startChat).mockResolvedValue({ requestId: 'request-1', messageId: 'assistant-1' });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'update the record');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Working')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'record-2' }));

    const warningDialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(warningDialog).toBeVisible();
    expect(within(warningDialog).getByText(/agent is still running/i)).toBeInTheDocument();
    expect(within(warningDialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(warningDialog).getByRole('button', { name: 'Discard changes' })).toBeDisabled();
    expect(screen.getByText('First answer')).toBeInTheDocument();

    hasDraft = true;
    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    await waitFor(() => expect(within(warningDialog).getByRole('button', { name: 'Discard changes' })).not.toBeDisabled());
    expect(api.getRecordDraftStatus).toHaveBeenCalledWith('sample-project', 'record-1');

    await userEvent.click(within(warningDialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(api.discardRecordChanges).toHaveBeenCalledWith('sample-project', 'record-1'));
    expect(await screen.findByText('Second answer')).toBeInTheDocument();
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
              editMode: 'logged'
            }
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={submit}
      />
    );

    expect(screen.getByLabelText('Edit')).toHaveDisplayValue('developer');
    expect(screen.queryByRole('option', { name: 'Choose edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stage feedback' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Edit'), 'SME');
    expect(screen.getByLabelText('Edit')).toHaveDisplayValue('SME');
    expect(submit).not.toHaveBeenCalled();
  });

  it('renders inline editable values without feedback controls', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <RenderTree
        node={{
          kind: 'object',
          label: 'record',
          children: [
            { kind: 'value', label: 'answer', path: '/answer', value: 'Original answer', validationIssues: [] },
            { kind: 'value', label: 'persona', path: '/persona', value: 'developer', enumValues: ['TPM', 'developer', 'SME'], validationIssues: [] }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
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
            '/persona': {
              path: '/persona',
              target: 'Persona',
              tab: 'Main',
              supportsEdit: true,
              feedback: 'none',
              comments: false,
              editMode: 'inline'
            }
          }
        }}
        projectUser={{ valid: false, validationMessage: 'USERNAME environment variable not configured. Please set USERNAME in your .env file.' }}
        onSubmitFeedback={submit}
      />
    );

    expect(screen.queryByRole('button', { name: 'Submit feedback' })).not.toBeInTheDocument();
    const answer = screen.getByLabelText('answer');
    expect(answer).toHaveAttribute('rows', '1');
    expect(answer).toHaveValue('Original answer');
    await userEvent.clear(answer);
    await userEvent.type(answer, 'Inline draft');
    expect(answer).toHaveValue('Inline draft');

    await userEvent.selectOptions(screen.getByLabelText('persona'), 'SME');
    expect(screen.getByLabelText('persona')).toHaveDisplayValue('SME');
    expect(submit).not.toHaveBeenCalled();
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
              editMode: 'logged'
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
    expect(screen.queryByRole('button', { name: 'Stage feedback' })).not.toBeInTheDocument();

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
