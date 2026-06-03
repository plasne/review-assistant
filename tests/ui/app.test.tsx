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
  getRecord: vi.fn(),
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

    expect(screen.queryByRole('heading', { name: 'Architecture Notes' })).not.toBeInTheDocument();
    expect(screen.getByText('Architecture Notes')).toBeInTheDocument();
    expect(screen.getByLabelText('Read-only evidence fields')).toBeInTheDocument();
    expect(screen.getByLabelText('Editable evidence fields')).toBeInTheDocument();
    expect(screen.getAllByText('doc-1').find((element) => element.closest('.evidence-field'))?.closest('.evidence-field')).toHaveClass('readonly');
    expect(screen.getByText('No edits yet.')).toBeInTheDocument();
    expect(screen.queryByText('The dial path enters through Dial Gateway.', { selector: 'dd' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Read-only').length).toBeGreaterThan(0);
    expect(screen.getByText('Logged')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence 1 feedback')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence 1 feedback value')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence 1 feedback').closest('details')?.querySelector('.history-rating-summary')?.textContent).toBe('👎,👍');
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
    await userEvent.click(within(editableField as HTMLElement).getByRole('button', { name: 'Stage feedback' }));
    expect(onSubmitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ propertyPath: '/turns/0/evidence/0/content', editValue: 'Edited evidence content' })
    );
  });

  it('renders evidence content with the diff-view presentation', () => {
    const commentSubmittedAt = new Date(Date.now() - 120000).toISOString();
    const editSubmittedAt = new Date(Date.now() - 60000).toISOString();
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
                { kind: 'value', label: 'source', path: '/turns/0/evidence/0/source', value: 'Architecture Notes', validationIssues: [] },
                {
                  kind: 'value',
                  label: 'content',
                  path: '/turns/0/evidence/0/content',
                  presentation: 'diff-view',
                  value: 'Updated evidence content.',
                  validationIssues: []
                }
              ],
              validationIssues: []
            }
          ],
          validationIssues: []
        }}
        history={{
          '/turns/0/evidence/0/content': {
            original: 'Original evidence content.',
            feedback: [],
            comments: [{ value: 'Add the update detail.', username: 'sme@example.com', timestamp: commentSubmittedAt }],
            edits: [{ value: 'Updated evidence content.', username: 'sme@example.com', timestamp: editSubmittedAt }]
          }
        }}
        feedbackConfig={{
          properties: {
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
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByLabelText('Editable evidence fields')).toBeInTheDocument();
    expect(screen.getByText('Logged')).toBeInTheDocument();
    expect(screen.getByLabelText('content feedback')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Updated evidence content.')).toBeInTheDocument();
    const diff = screen.getByLabelText('Diff preview');
    expect(diff).toBeInTheDocument();
    expect(screen.getByText('Diff preview')).toBeInTheDocument();
    expect(diff.querySelector('diffs-container')).not.toBeNull();
    expect(screen.getByLabelText('Comment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage feedback' })).toBeDisabled();
    expect(screen.getByText('History (3)')).toBeInTheDocument();
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

  it('auto-opens evidence nodes into tabs and limits open-tab actions to evidence', async () => {
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
      data: { answer: 'Run npm run check.', evidence: [{ id: 'doc-1', source: 'README' }] },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [
          { kind: 'value', label: 'answer', path: '/answer', value: 'Run npm run check.', validationIssues: [] },
          {
            kind: 'array',
            label: 'evidence',
            path: '/evidence',
            presentation: 'evidence-list',
            items: [
              {
                kind: 'object',
                label: '0',
                path: '/evidence/0',
                children: [
                  { kind: 'value', label: 'id', path: '/evidence/0/id', value: 'doc-1', validationIssues: [] },
                  { kind: 'value', label: 'source', path: '/evidence/0/source', value: 'README', validationIssues: [] }
                ],
                validationIssues: []
              }
            ],
            validationIssues: []
          }
        ],
        validationIssues: []
      }
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'valid-record' }));

    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'evidence (/evidence)' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByRole('tab', { name: 'answer (/answer)' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Run npm run check.');
    expect(screen.getByRole('heading', { name: 'evidence 1 item' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'evidence (/evidence)' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('doc-1');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('README');
    expect(within(screen.getByRole('tabpanel')).queryByRole('heading', { name: 'answer' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).queryByRole('heading', { name: 'README' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    const answerSection = screen.getByRole('heading', { name: 'answer' }).closest('section');
    expect(answerSection).not.toBeNull();
    expect(within(answerSection as HTMLElement).queryByRole('button', { name: 'Open in tab' })).not.toBeInTheDocument();
    const evidenceGroup = screen.getByRole('heading', { name: 'evidence 1 item' }).closest('details');
    expect(evidenceGroup).not.toBeNull();
    expect(evidenceGroup).toHaveClass('evidence-list');
    expect(evidenceGroup).toHaveAttribute('open');
    expect((evidenceGroup as HTMLElement).firstElementChild?.tagName).toBe('SUMMARY');
    expect(within(evidenceGroup as HTMLElement).getByRole('button', { name: 'Open in tab' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'evidence 1 item' })).toBeInTheDocument();
    expect(within(evidenceGroup as HTMLElement).getByText('README')).not.toBeVisible();
  });

  it('auto-opens the first project and first record when autoOpenFirst is enabled', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [
        { id: 'sample-project', name: 'sample-project' },
        { id: 'other-project', name: 'other-project' }
      ],
      version: 'v0.1.0-test',
      autoOpenFirst: true
    });
    vi.mocked(api.openProject).mockResolvedValue({
      project: { id: 'sample-project', name: 'sample-project' },
      projectConfig: {},
      schema: {},
      records: [
        { id: 'first-record', displayName: 'first-record' },
        { id: 'second-record', displayName: 'second-record' }
      ]
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'first-record',
      displayName: 'first-record',
      data: { answer: 'Auto opened answer.' },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [{ kind: 'value', label: 'answer', path: '/answer', value: 'Auto opened answer.', validationIssues: [] }],
        validationIssues: []
      }
    });

    render(<App />);

    expect(await screen.findByText('Auto opened answer.')).toBeInTheDocument();
    expect(api.openProject).toHaveBeenCalledWith('sample-project');
    expect(api.getRecord).toHaveBeenCalledWith('sample-project', 'first-record');
    expect(await screen.findByLabelText('Current project')).toHaveValue('sample-project');
  });

  it('does not auto-open when autoOpenFirst is disabled', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [{ id: 'sample-project', name: 'sample-project' }],
      version: 'v0.1.0-test',
      autoOpenFirst: false
    });

    render(<App />);

    expect(await screen.findByLabelText('Current project')).toHaveValue('');
    expect(api.openProject).not.toHaveBeenCalled();
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
    const workspace = screen.getByRole('main', { name: 'Review workspace' });
    expect(await screen.findByRole('button', { name: 'Configure' })).toBeDisabled();
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await waitFor(() => expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com'));
    const recordList = await screen.findByRole('region', { name: 'Records list' });
    const recordButton = await screen.findByRole('button', { name: 'valid-record' });
    expect(screen.getByRole('separator', { name: 'Resize records and details columns' })).toBeInTheDocument();
    expect(workspace.querySelector('.column-divider')).not.toBeInTheDocument();
    expect(recordList).toContainElement(recordButton);
    await userEvent.click(recordButton);
    expect(await screen.findByText('Record passes schema validation.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Records list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize records and details columns' })).not.toBeInTheDocument();
    expect(workspace.querySelector('.column-divider')).toBeInTheDocument();
    const expandRecords = screen.getByRole('button', { name: 'Expand records sidebar' });
    expect(expandRecords).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expandRecords);
    expect(await screen.findByRole('region', { name: 'Records list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse records sidebar' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('separator', { name: 'Resize records and details columns' })).toBeInTheDocument();
    expect(workspace.querySelector('.column-divider')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'record' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'question' })).toBeInTheDocument();
    expect(screen.getByText('How?')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message GitHub Copilot'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'hello', []));
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

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith('sample-project', 'valid-record', 'who is the persona?', []));
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

    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'general question', []));
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
      expect(api.startChat).toHaveBeenNthCalledWith(1, 'sample-project', 'valid-record', 'search for "configuration management"', [])
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
        ])
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
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'line one\nline two', []));
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
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(undefined, undefined, 'slow answer', []));
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
    await userEvent.click(screen.getByRole('button', { name: 'Stage feedback' }));

    await userEvent.click(screen.getByRole('button', { name: 'Expand records sidebar' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('dialog', { name: 'Create project' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Project name'), 'new-project');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Stage feedback' }));
    expect(await screen.findByText('Unsaved changes')).toHaveClass('unsaved-status');

    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await userEvent.type(await screen.findByLabelText('Project name'), 'new-project');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

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
    expect(screen.getByRole('button', { name: 'Stage feedback' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: 'Stage feedback' })).toBeDisabled();
    expect(screen.getByLabelText('Current feedback username')).toHaveTextContent('sme@example.com');
    expect(screen.queryByText(/Feedback mode:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Good' }));
    await userEvent.type(screen.getByLabelText('Comment'), 'Looks right');
    await userEvent.click(screen.getByRole('button', { name: 'Stage feedback' }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalledWith('sample-project', 'valid-record', expect.objectContaining({ propertyPath: '/answer' })));
    expect(screen.getByText('Unsaved changes')).toHaveClass('unsaved-status');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveRecordChanges).toHaveBeenCalledWith('sample-project', 'valid-record'));
    expect(await screen.findByText('All changes saved')).toHaveClass('saved-status');

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
    await userEvent.click(screen.getByRole('button', { name: 'Stage feedback' }));
    expect(await screen.findByText('Unsaved changes')).toHaveClass('unsaved-status');

    act(() => {
      listeners.closeRequested.forEach((listener) => listener());
    });
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(api.closeWindow).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Expand records sidebar' }));
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

    await userEvent.click(screen.getByRole('button', { name: 'Expand records sidebar' }));
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
    expect(screen.getByRole('button', { name: 'Stage feedback' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Edit'), 'SME');
    await userEvent.click(screen.getByRole('button', { name: 'Stage feedback' }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ propertyPath: '/persona', editValue: 'SME' }));
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
    expect(screen.getByRole('button', { name: 'Stage feedback' })).toBeDisabled();

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
