import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, RenderTree } from '../../src/renderer/main';
import type {
  Api,
  ChatCanceled,
  ChatStreamChunk,
  ChatStreamComplete,
  ChatStreamError,
  GitHubLoginCompletion,
  RenderNode,
  Theme,
  ThemeState,
  ThemeTokens
} from '../../src/shared/types';

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
  computeRecordTags: vi.fn(),
  getRecordDraftStatus: vi.fn(),
  saveRecordChanges: vi.fn(),
  discardRecordChanges: vi.fn(),
  getFeedbackConfig: vi.fn(),
  saveFeedbackConfig: vi.fn(),
  getThemeState: vi.fn(),
  saveTheme: vi.fn(),
  deleteTheme: vi.fn(),
  setActiveTheme: vi.fn(),
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

const bootstrapThemeTokens: ThemeTokens = {
  bg: '#201122',
  bg2: '#241628',
  surface: '#2b1830',
  surface2: '#362040',
  border: '#6d4b78',
  text: '#f9efff',
  textDim: '#c8afd1',
  accent: '#ff8bd8',
  accent2: '#8bd3ff',
  success: '#8be69c',
  warning: '#ffd166',
  danger: '#ff9aa8',
  focusRing: '#f4a7ff',
  fontSans: '"Bootstrap Sans", sans-serif',
  fontSerif: '"Bootstrap Serif", serif'
};

const alternateThemeTokens: ThemeTokens = {
  ...bootstrapThemeTokens,
  bg: '#042a2b',
  bg2: '#063536',
  surface: '#0b4446',
  surface2: '#0f5658',
  text: '#e6fffb',
  accent: '#2dd4bf'
};

const createThemeState = (): ThemeState => ({
  activeThemeId: 'bootstrap-theme',
  themes: [
    {
      id: 'bootstrap-theme',
      name: 'Bootstrap Theme',
      builtIn: true,
      tokens: bootstrapThemeTokens
    },
    {
      id: 'warm-theme',
      name: 'Warm Theme',
      builtIn: true,
      tokens: alternateThemeTokens
    }
  ]
});

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute('style');
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
  vi.mocked(api.saveRecordChanges).mockImplementation(async (projectId, recordId) => ({ record: await api.getRecord(projectId, recordId) }));
  vi.mocked(api.computeRecordTags).mockImplementation(async (projectId, recordId) => ({ record: await api.getRecord(projectId, recordId) }));
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
  it('applies the active bootstrap theme before rendering loaded UI state', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      themeState: {
        activeThemeId: 'bootstrap-theme',
        themes: [
          {
            id: 'bootstrap-theme',
            name: 'Bootstrap Theme',
            builtIn: false,
            tokens: bootstrapThemeTokens
          }
        ]
      },
      version: 'v0.1.0-test'
    });

    render(<App />);

    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#201122'));
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('#2b1830');
    expect(document.documentElement.style.getPropertyValue('--text')).toBe('#f9efff');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('"Bootstrap Sans", sans-serif');
    expect(await screen.findByLabelText('Current project')).toBeInTheDocument();
  });

  it('selects a built-in theme through the typed preload API and applies it immediately', async () => {
    const initialThemeState = createThemeState();
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      themeState: initialThemeState,
      version: 'v0.1.0-test'
    });
    vi.mocked(api.setActiveTheme).mockImplementation(async (themeId) => ({ ...initialThemeState, activeThemeId: themeId }));

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage themes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Themes' });

    await userEvent.selectOptions(within(dialog).getByLabelText('Active theme'), 'warm-theme');

    expect(api.setActiveTheme).toHaveBeenCalledWith('warm-theme');
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#042a2b'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2dd4bf');
  });

  it('authors a custom theme, saves it through preload, and applies the persisted selection', async () => {
    const initialThemeState = createThemeState();
    let savedTheme: Theme | undefined;
    vi.mocked(api.getBootstrap).mockResolvedValue({
      backendKind: 'local',
      projects: [],
      themeState: initialThemeState,
      version: 'v0.1.0-test'
    });
    vi.mocked(api.saveTheme).mockImplementation(async (theme) => {
      savedTheme = theme;
      return { activeThemeId: initialThemeState.activeThemeId, themes: [...initialThemeState.themes, theme] };
    });
    vi.mocked(api.setActiveTheme).mockImplementation(async (themeId) => ({
      activeThemeId: themeId,
      themes: savedTheme ? [...initialThemeState.themes, savedTheme] : initialThemeState.themes
    }));

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage themes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Themes' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'New custom theme' }));
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Custom Ocean');
    await userEvent.clear(within(dialog).getByLabelText('Identifier'));
    await userEvent.type(within(dialog).getByLabelText('Identifier'), 'custom-ocean');
    await userEvent.clear(within(dialog).getByLabelText('Background'));
    await userEvent.type(within(dialog).getByLabelText('Background'), '#001122');
    await userEvent.clear(within(dialog).getByLabelText('Accent'));
    await userEvent.type(within(dialog).getByLabelText('Accent'), '#33ddff');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and apply' }));

    expect(api.saveTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'custom-ocean',
        name: 'Custom Ocean',
        builtIn: false,
        tokens: expect.objectContaining({ bg: '#001122', accent: '#33ddff' })
      })
    );
    expect(api.setActiveTheme).toHaveBeenCalledWith('custom-ocean');
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#001122'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#33ddff');
  });

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
                { kind: 'value', label: 'uri', path: '/turns/0/evidence/0/uri', value: 'https://github.com/example/repo/blob/main/README.md', validationIssues: [] },
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
              feedback: 'thumbs',
              comments: false,
              editMode: 'none'
            },
            '/turns/*/evidence/*/id': {
              path: '/turns/*/evidence/*/id',
              target: 'Evidence > Id',
              tab: 'Evidence',
              feedback: 'none',
              comments: false,
              editMode: 'none'
            },
            '/turns/*/evidence/*/content': {
              path: '/turns/*/evidence/*/content',
              target: 'Evidence > Content',
              tab: 'Evidence',
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

    expect(screen.getByRole('heading', { name: 'doc-1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'doc-1' }).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Read-only evidence fields')).toBeInTheDocument();
    expect(screen.getByLabelText('Editable evidence fields')).toBeInTheDocument();
    expect(screen.getAllByText('doc-1').find((element) => element.closest('.evidence-field'))?.closest('.evidence-field')).toHaveClass('readonly');
    const uriLink = screen.getByRole('link', { name: 'https://github.com/example/repo/blob/main/README.md' });
    expect(uriLink).toHaveAttribute('target', '_blank');
    expect(uriLink).toHaveClass('evidence-value-link');
    expect(screen.getByText('No edits yet.')).toBeInTheDocument();
    expect(screen.queryByText('The dial path enters through Dial Gateway.', { selector: 'dd' })).not.toBeInTheDocument();
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0);
    expect(screen.getByText('logged')).toBeInTheDocument();
    expect(screen.getByLabelText('doc-1 feedback')).toBeInTheDocument();
    expect(screen.getByLabelText('doc-1 feedback value')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'doc-1' }).closest('summary')).toHaveAccessibleName(
      'doc-1 Feedback ratings: thumbs down, thumbs up'
    );
    expect(screen.getByRole('heading', { name: 'doc-1' }).closest('summary')?.querySelector('.history-rating-summary')?.textContent).toBe('👎,👍');
    const contentFeedback = screen.getByLabelText('content feedback');
    expect(contentFeedback).toBeInTheDocument();
    expect(contentFeedback.textContent?.indexOf('Edit')).toBeLessThan(contentFeedback.textContent?.indexOf('Comment') ?? 0);
    expect(screen.queryByLabelText('id feedback')).not.toBeInTheDocument();
    const editableField = screen.getByText('content').closest('.evidence-field');
    expect(editableField).not.toBeNull();
    expect(editableField).toHaveClass('evidence-field-content');
    const editInput = within(editableField as HTMLElement).getByLabelText('Edit');
    await userEvent.clear(editInput);
    await userEvent.type(editInput, 'Edited evidence content');
    expect(within(editableField as HTMLElement).getByLabelText('Edit')).toHaveValue('Edited evidence content');
    expect(onSubmitFeedback).not.toHaveBeenCalled();
  });

  it('renders evidence lists as open disclosure groups without open-tab actions', async () => {
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
                { kind: 'value', label: 'source', path: '/turns/0/evidence/0/source', value: 'Architecture Notes', validationIssues: [] }
              ],
              validationIssues: []
            }
          ],
          validationIssues: []
        }}
      />
    );

    const evidenceGroup = screen.getByText('evidence', { selector: '.field-label' }).closest('details');
    expect(evidenceGroup).not.toBeNull();
    expect(evidenceGroup).toHaveClass('evidence-list');
    expect(evidenceGroup).toHaveAttribute('open');
    expect(within(evidenceGroup as HTMLElement).queryByRole('button', { name: 'Open in tab' })).not.toBeInTheDocument();
    const evidenceCard = within(evidenceGroup as HTMLElement).getByRole('heading', { name: 'doc-1' }).closest('details');
    expect(evidenceCard).not.toHaveAttribute('open');

    await userEvent.click((evidenceGroup as HTMLElement).querySelector('summary') as HTMLElement);

    expect(evidenceGroup).not.toHaveAttribute('open');
  });

  it('renders tags as computed and manual groups with manual edits gated by edit mode', () => {
    const node: RenderNode = {
      kind: 'array',
      label: 'tags',
      path: '/tags',
      items: [
        { kind: 'value', label: '0', path: '/tags/0', value: 'needs-review', type: 'string', validationIssues: [] },
        { kind: 'value', label: '1', path: '/tags/1', value: 'computed-risk', type: 'string', validationIssues: [] }
      ],
      validationIssues: []
    };
    const feedbackConfig = {
      properties: {
        '/tags': {
          path: '/tags',
          target: 'Tags',
          tab: 'Main',
          feedback: 'none' as const,
          comments: false,
          editMode: 'inline' as const,
          presentation: 'tags' as const,
          mapping: 'tags' as const
        }
      }
    };

    const { rerender } = render(
      <RenderTree
        node={node}
        feedbackConfig={feedbackConfig}
        tagDefinitions={[{ name: 'needs-review', description: 'Needs review' }, { name: 'approved', description: 'Approved' }]}
      />
    );

    expect(within(screen.getByLabelText('Manual tags')).getByText('needs-review')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Computed tags')).getByText('computed-risk')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove needs-review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove computed-risk' })).not.toBeInTheDocument();
    const addManualTag = screen.getByLabelText('Add tags manual tag');
    expect(addManualTag).toBeEnabled();
    expect(addManualTag).toHaveRole('combobox');
    expect(within(addManualTag).queryByRole('option', { name: 'computed-risk' })).not.toBeInTheDocument();
    expect(within(addManualTag).getByRole('option', { name: 'approved' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /tags/i })).not.toBeInTheDocument();

    rerender(
      <RenderTree
        node={node}
        feedbackConfig={{
          properties: {
            '/tags': {
              ...feedbackConfig.properties['/tags'],
              editMode: 'none'
            }
          }
        }}
        tagDefinitions={[{ name: 'needs-review', description: 'Needs review' }]}
      />
    );

    expect(screen.queryByRole('button', { name: 'Remove needs-review' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add tags manual tag')).not.toBeInTheDocument();
  });

  it('keeps mapped tag arrays free-form when the tags presentation is not configured', () => {
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'tags',
          path: '/tags',
          items: [{ kind: 'value', label: '0', path: '/tags/0', value: 'needs-review', type: 'string', validationIssues: [] }],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/tags': {
              path: '/tags',
              target: 'Tags',
              tab: 'Main',
              feedback: 'none',
              comments: false,
              editMode: 'inline',
              mapping: 'tags'
            }
          }
        }}
        tagDefinitions={[{ name: 'approved', description: 'Approved' }]}
      />
    );

    expect(screen.queryByLabelText('Add tags manual tag')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'tags item 1' })).toBeInTheDocument();
  });

  it('replaces an existing manual tag from the same domain in the tags presentation', async () => {
    const onChangeFeedbackDraft = vi.fn();
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'tags',
          path: '/tags',
          items: [
            { kind: 'value', label: '0', path: '/tags/0', value: 'priority:high', type: 'string', validationIssues: [] },
            { kind: 'value', label: '1', path: '/tags/1', value: 'computed-risk', type: 'string', validationIssues: [] },
            { kind: 'value', label: '2', path: '/tags/2', value: 'status:open', type: 'string', validationIssues: [] }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/tags': {
              path: '/tags',
              target: 'Tags',
              tab: 'Main',
              feedback: 'none',
              comments: false,
              editMode: 'logged',
              presentation: 'tags'
            }
          }
        }}
        tagDefinitions={[
          { name: 'priority:high', description: 'High priority' },
          { name: 'priority:low', description: 'Low priority' },
          { name: 'status:open', description: 'Open' },
          { name: 'status:closed', description: 'Closed' }
        ]}
        history={{}}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn()}
        feedbackDrafts={{}}
        onChangeFeedbackDraft={onChangeFeedbackDraft}
      />
    );

    await userEvent.selectOptions(screen.getByLabelText('Add tags manual tag'), 'priority:low');

    expect(onChangeFeedbackDraft).toHaveBeenLastCalledWith(
      '/tags',
      expect.objectContaining({ editValue: 'priority:low\ncomputed-risk\nstatus:open' })
    );
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

  it('opens mapped turn items in dedicated tabs while keeping the turns container in the overview', async () => {
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
          '/conversation/turns': {
            path: '/conversation/turns',
            target: 'Turns',
            tab: 'Main',
            feedback: 'thumbs',
            comments: true,
            editMode: 'none',
            mapping: 'turns'
          }
        }
      }
    });
    vi.mocked(api.getRecord).mockResolvedValue({
      projectId: 'sample-project',
      recordId: 'valid-record',
      displayName: 'valid-record',
      data: { conversation: { turns: [{ prompt: 'How?', answer: 'Use the harness.' }, { prompt: 'Why?', answer: 'It is deterministic.' }] } },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [
          {
            kind: 'object',
            label: 'conversation',
            path: '/conversation',
            children: [
              {
                kind: 'array',
                label: 'turns',
                path: '/conversation/turns',
                description: 'Conversation turns for this review.',
                items: [
                  {
                    kind: 'object',
                    label: '0',
                    path: '/conversation/turns/0',
                    children: [
                      { kind: 'value', label: 'prompt', path: '/conversation/turns/0/prompt', value: 'How?', validationIssues: [] },
                      { kind: 'value', label: 'answer', path: '/conversation/turns/0/answer', value: 'Use the harness.', validationIssues: [] }
                    ],
                    validationIssues: []
                  },
                  {
                    kind: 'object',
                    label: '1',
                    path: '/conversation/turns/1',
                    children: [
                      { kind: 'value', label: 'prompt', path: '/conversation/turns/1/prompt', value: 'Why?', validationIssues: [] },
                      { kind: 'value', label: 'answer', path: '/conversation/turns/1/answer', value: 'It is deterministic.', validationIssues: [] }
                    ],
                    validationIssues: []
                  }
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
    expect(screen.getByRole('tab', { name: 'Turn 0' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Turn 1' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('heading', { name: 'turns Conversation turns for this review. 2 items' })).toBeInTheDocument();
    expect(screen.getByText('(shown in tabs)')).toBeInTheDocument();
    expect(screen.queryByText('Use the harness.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Turn 1' }));

    expect(screen.getByRole('tab', { name: 'Turn 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Why?');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('It is deterministic.');
    expect(within(screen.getByRole('tabpanel')).queryByRole('heading', { name: '1' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).queryByRole('heading', { name: 'turns Conversation turns for this review. 2 items' })).not.toBeInTheDocument();
  });

  it('does not show turn tabs when the turns mapping is not configured', async () => {
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
      data: { turns: [{ prompt: 'How?', answer: 'Inline answer.' }] },
      schema: {},
      validationIssues: [],
      renderTree: {
        kind: 'object',
        label: 'record',
        path: '',
        children: [
          {
            kind: 'array',
            label: 'turns',
            path: '/turns',
            items: [
              {
                kind: 'object',
                label: '0',
                path: '/turns/0',
                children: [
                  { kind: 'value', label: 'prompt', path: '/turns/0/prompt', value: 'How?', validationIssues: [] },
                  { kind: 'value', label: 'answer', path: '/turns/0/answer', value: 'Inline answer.', validationIssues: [] }
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

    expect(screen.queryByRole('tablist', { name: 'Record detail tabs' })).not.toBeInTheDocument();
    expect(await screen.findByText('Inline answer.')).toBeInTheDocument();
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
    expect(configureButton).toHaveAttribute('data-tooltip', 'Configure project');
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
    expect(await screen.findByRole('dialog', { name: 'Project configuration' })).toBeVisible();
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
    expect(screen.queryByText('Agent is still running...')).not.toBeInTheDocument();
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
    expect(screen.queryByText('Agent is still running...')).not.toBeInTheDocument();
    act(() => {
      listeners.complete.forEach((listener) => listener({ requestId: 'request-1', messageId: 'assistant-1' }));
    });
    await waitFor(() => expect(screen.getByText('Partial answer').closest('article')).not.toHaveClass('pending'));
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
    expect(screen.queryByRole('combobox', { name: 'persona' })).not.toBeInTheDocument();
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
        '/id': { path: '/id', target: 'ID', tab: 'Record', feedback: 'none' as const, comments: false, editMode: 'inline' as const },
        '/persona': {
          path: '/persona',
          target: 'Persona',
          tab: 'Record',
          feedback: 'none' as const,
          comments: false,
          editMode: 'inline' as const
        },
        '/turns': { path: '/turns', target: 'Turns', tab: 'Record', feedback: 'none' as const, comments: false, editMode: 'none' as const }
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
    vi.mocked(api.saveRecordChanges).mockImplementation(async () => ({ record: recordDetail(stagedData) }));

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

  it('stages inline edits for string arrays from the array field', async () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } }
      }
    };
    const feedbackConfig = {
      properties: {
        '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none' as const, comments: false, editMode: 'inline' as const }
      }
    };
    const recordDetail = (tags: string[]) => ({
      projectId: 'sample-project',
      recordId: 'record-1',
      displayName: 'record-1',
      data: { tags },
      schema,
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [
          {
            kind: 'array' as const,
            label: 'tags',
            path: '/tags',
            items: tags.map((tag, index) => ({
              kind: 'value' as const,
              label: String(index),
              path: `/tags/${index}`,
              value: tag,
              type: 'string',
              validationIssues: []
            })),
            validationIssues: []
          }
        ],
        validationIssues: []
      },
      feedbackHistory: {}
    });
    let stagedTags: string[] = ['domain:legal', 'turns:multi'];
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
    vi.mocked(api.getRecord).mockResolvedValue(recordDetail(stagedTags));
    vi.mocked(api.updateRecordData).mockImplementation(async (_projectId, _recordId, data) => {
      stagedTags = (data as { tags: string[] }).tags;
      return recordDetail(stagedTags);
    });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    const tagsSection = (await screen.findByText('tags', { selector: '.field-label' })).closest('section') as HTMLElement;
    expect(within(tagsSection).getByText('2 items')).toBeInTheDocument();
    expect(within(tagsSection).queryByText('0')).not.toBeInTheDocument();
    expect(within(tagsSection).queryByText('1')).not.toBeInTheDocument();
    expect(tagsSection.querySelector('textarea')).toBeNull();
    expect(await within(tagsSection).findByLabelText('tags item 1')).toHaveValue('domain:legal');
    expect(within(tagsSection).getByLabelText('tags item 2')).toHaveValue('turns:multi');
    const addTagInput = within(tagsSection).getByLabelText('tags new item');
    expect(addTagInput).toHaveValue('');
    expect(screen.queryByText('Tags > *')).not.toBeInTheDocument();
    await userEvent.type(addTagInput, 'domain:privacy');

    await waitFor(() => expect(api.updateRecordData).toHaveBeenLastCalledWith('sample-project', 'record-1', { tags: ['domain:legal', 'turns:multi', 'domain:privacy'] }));
    expect(stagedTags).toEqual(['domain:legal', 'turns:multi', 'domain:privacy']);
    await waitFor(() => expect(within(tagsSection).getByText('3 items')).toBeInTheDocument());
    expect(within(tagsSection).getByLabelText('tags new item')).toHaveValue('');
  });

  it('computes presentation tags without saving the record', async () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } }
      }
    };
    const feedbackConfig = {
      properties: {
        '/tags': {
          path: '/tags',
          target: 'Tags',
          tab: 'Main',
          feedback: 'none' as const,
          comments: false,
          editMode: 'inline' as const,
          presentation: 'tags' as const,
          mapping: 'tags' as const
        }
      }
    };
    const recordDetail = (tags: string[]) => ({
      projectId: 'sample-project',
      recordId: 'record-1',
      displayName: 'record-1',
      data: { tags },
      schema,
      validationIssues: [],
      renderTree: {
        kind: 'object' as const,
        label: 'record',
        path: '',
        children: [
          {
            kind: 'array' as const,
            label: 'tags',
            path: '/tags',
            items: tags.map((tag, index) => ({
              kind: 'value' as const,
              label: String(index),
              path: `/tags/${index}`,
              value: tag,
              type: 'string',
              validationIssues: []
            })),
            validationIssues: []
          }
        ],
        validationIssues: []
      },
      feedbackHistory: {}
    });
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
      feedbackConfig,
      tagDefinitions: [{ name: 'manual', description: 'Manual tag' }]
    });
    vi.mocked(api.getRecord).mockResolvedValue(recordDetail(['manual']));
    vi.mocked(api.computeRecordTags).mockResolvedValue({ record: recordDetail(['manual', 'turns:single']) });

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Current project'), 'sample-project');
    await userEvent.click(await screen.findByRole('button', { name: 'record-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Compute tags' }));

    await waitFor(() => expect(api.computeRecordTags).toHaveBeenCalledWith('sample-project', 'record-1'));
    expect(api.saveRecordChanges).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText('Computed tags')).getByText('turns:single')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('renders string arrays without numeric labels in read-only mode', () => {
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'tags',
          path: '/tags',
          items: [
            { kind: 'value', label: '0', path: '/tags/0', value: 'domain:legal', type: 'string', validationIssues: [] },
            { kind: 'value', label: '1', path: '/tags/1', value: 'turns:multi', type: 'string', validationIssues: [] }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, editMode: 'none' }
          }
        }}
        history={{}}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn()}
      />
    );

    const tagsSection = (screen.getByText('tags', { selector: '.field-label' })).closest('section') as HTMLElement;
    expect(within(tagsSection).getByText('2 items')).toBeInTheDocument();
    expect(within(tagsSection).queryByText('0')).not.toBeInTheDocument();
    expect(within(tagsSection).queryByText('1')).not.toBeInTheDocument();
    expect(tagsSection.querySelector('textarea')).toBeNull();
    expect(within(tagsSection).getByText('domain:legal', { selector: 'output' })).toHaveClass('array-string-output');
    expect(within(tagsSection).getByText('domain:legal', { selector: 'output' })).not.toHaveClass('inline-edit-value');
    expect(within(tagsSection).getByText('turns:multi', { selector: 'output' })).toHaveClass('array-string-output');
    expect(within(tagsSection).queryByLabelText('tags new item')).not.toBeInTheDocument();
  });

  it('stages logged string-array edits with row inputs instead of a textarea', async () => {
    const onChangeFeedbackDraft = vi.fn();
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'tags',
          path: '/tags',
          items: [{ kind: 'value', label: '0', path: '/tags/0', value: 'domain:legal', type: 'string', validationIssues: [] }],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, editMode: 'logged' }
          }
        }}
        history={{}}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn()}
        feedbackDrafts={{}}
        onChangeFeedbackDraft={onChangeFeedbackDraft}
      />
    );

    const tagsSection = (screen.getByText('tags', { selector: '.field-label' })).closest('section') as HTMLElement;
    expect(within(tagsSection).queryByText('0')).not.toBeInTheDocument();
    expect(tagsSection.querySelector('textarea')).toBeNull();
    await userEvent.type(within(tagsSection).getByLabelText('tags new item'), 'source:sme');

    expect(onChangeFeedbackDraft).toHaveBeenLastCalledWith('/tags', expect.objectContaining({ editValue: 'domain:legal\nsource:sme' }));
    expect(within(tagsSection).getByText('2 items')).toBeInTheDocument();
  });

  it('formats string-array history values as comma-delimited lists', async () => {
    render(
      <RenderTree
        node={{
          kind: 'array',
          label: 'tags',
          path: '/tags',
          items: [
            { kind: 'value', label: '0', path: '/tags/0', value: 'domain:legal', type: 'string', validationIssues: [] },
            { kind: 'value', label: '1', path: '/tags/1', value: 'source:sme', type: 'string', validationIssues: [] }
          ],
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, editMode: 'logged' }
          }
        }}
        history={{
          '/tags': {
            feedback: [],
            comments: [],
            edits: [{ value: 'domain:legal\nsource:sme', username: 'sme@example.com', timestamp: '2026-06-01T20:00:00.000Z' }],
            original: '["domain:legal","turns:multi"]'
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn()}
        feedbackDrafts={{}}
        onChangeFeedbackDraft={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText('History (2)'));
    const historyLines = screen.getAllByText(/^(original:|edit:)$/).map((element) => element.closest('.history-line')?.textContent);
    expect(historyLines).toEqual(['edit:domain:legal, source:sme', 'original:domain:legal, turns:multi']);
  });

  it('renders empty original values in history', async () => {
    render(
      <RenderTree
        node={{
          kind: 'value',
          label: 'bucket',
          path: '/bucket',
          value: 'new bucket value',
          type: 'string',
          validationIssues: []
        }}
        feedbackConfig={{
          properties: {
            '/bucket': { path: '/bucket', target: 'Bucket', tab: 'Main', feedback: 'none', comments: false, editMode: 'logged' }
          }
        }}
        history={{
          '/bucket': {
            feedback: [],
            comments: [],
            edits: [
              { value: 'new bucket value', username: 'sme@example.com', timestamp: '2026-06-01T20:00:00.000Z' },
              { value: 'one more change', username: 'sme@example.com', timestamp: '2026-06-01T20:01:00.000Z' }
            ],
            original: ''
          }
        }}
        projectUser={{ username: 'sme@example.com', valid: true }}
        onSubmitFeedback={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText('History (3)'));
    const historyLines = screen.getAllByText(/^(original:|edit:)$/).map((element) => element.closest('.history-line')?.textContent);
    expect(historyLines).toEqual(['edit:one more change', 'edit:new bucket value', 'original:(empty)']);
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
        '/answer': { path: '/answer', target: 'Answer', tab: 'Record', feedback: 'none' as const, comments: false, editMode: 'inline' as const }
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
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
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
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
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
          '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'none', comments: false, editMode: 'none' }
        }
      }
    });
    vi.mocked(api.getProjectUser).mockResolvedValue({
      valid: false,
      validationMessage: 'USERNAME environment variable not configured. Please set USERNAME in your config/.env file.'
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
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your config/.env file.')).not.toBeInTheDocument();
    expect(screen.queryByText('History (0)')).not.toBeInTheDocument();
  });

  it('applies saved feedback configuration to the currently displayed record', async () => {
    const feedbackConfig = {
      properties: {
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'none' as const, comments: false, editMode: 'none' as const }
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
    await userEvent.selectOptions(screen.getByLabelText('Answer edit mode'), 'logged');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Project configuration' })).getByRole('button', { name: 'Save' }));

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
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'none' as const, comments: false, editMode: 'none' as const },
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', feedback: 'none' as const, comments: false },
        '/evidence/*': { path: '/evidence/*', target: 'Evidence > *', tab: 'inherit', feedback: 'none' as const, comments: false },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', feedback: 'none' as const, comments: false, editMode: 'none' as const },
        '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none' as const, comments: false, editMode: 'none' as const }
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
          evidence: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          tags: { type: 'array' }
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
    const configDialog = await screen.findByRole('dialog', { name: 'Project configuration' });
    expect(configDialog).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'TAB' })).not.toBeInTheDocument();
    expect(within(configDialog).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['TARGET', 'FEEDBACK', 'COMMENT', 'EDIT MODE', 'PRESENTATION', 'MAPPING']);
    expect(screen.getByLabelText('Evidence feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence > * feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Evidence > Id feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Tags feedback mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Tags edit mode')).not.toBeDisabled();
    expect(screen.queryByText('Tags > *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Evidence edit mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Evidence > * edit mode')).not.toBeInTheDocument();
    expect(screen.queryByText('array')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Evidence > * canonical mapping')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Evidence > Id edit mode')).not.toBeDisabled();
    expect(screen.getByLabelText('Answer edit mode')).toHaveDisplayValue('none');
    expect(screen.queryByRole('option', { name: 'text_only' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Answer feedback mode'), 'good_fair_bad');
    await userEvent.selectOptions(screen.getByLabelText('Answer edit mode'), 'logged');
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
    expect(screen.queryByText('USERNAME environment variable not configured. Please set USERNAME in your config/.env file.')).not.toBeInTheDocument();
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
        '/answer': { path: '/answer', target: 'Answer', tab: 'Main', feedback: 'good_fair_bad' as const, comments: false, editMode: 'none' as const }
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

  it('renders schema descriptions inline, enum values as plain read-only text, and array objects collapsed with counts', async () => {
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
    expect(screen.queryByRole('combobox', { name: 'persona' })).not.toBeInTheDocument();
    expect(screen.getByText('developer', { selector: 'output' })).toBeInTheDocument();
    expect(screen.getByText('evidence')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('doc-1', { selector: '.array-item-identifier' })).toBeVisible();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.getByText('README')).not.toBeVisible();

    await userEvent.click(screen.getByText('doc-1', { selector: '.array-item-identifier' }));
    expect(screen.getByText('README')).toBeVisible();
  });

  it('renders not-set placeholders for schema-backed empty and missing values', () => {
    const node: RenderNode = {
      kind: 'object',
      label: 'record',
      children: [
        { kind: 'value', label: 'missingField', value: undefined, validationIssues: [] },
        { kind: 'value', label: 'emptyField', value: '', validationIssues: [] },
        { kind: 'value', label: 'nullField', value: null, validationIssues: [] },
        { kind: 'array', label: 'emptyArray', items: [], validationIssues: [] }
      ],
      validationIssues: []
    };

    render(<RenderTree node={node} />);

    expect(screen.getByRole('heading', { name: 'missingField' }).closest('section')).toHaveTextContent('(not set)');
    expect(screen.getByRole('heading', { name: 'emptyField' }).closest('section')).toHaveTextContent('(not set)');
    expect(screen.getByRole('heading', { name: 'nullField' }).closest('section')).toHaveTextContent('(not set)');
    expect(screen.getByRole('heading', { name: 'emptyArray 0 items' }).closest('section')).toHaveTextContent('(not set)');
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
    expect(screen.getByText('logged')).toHaveClass('field-edit-mode-logged');
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
              feedback: 'none',
              comments: false,
              editMode: 'inline'
            },
            '/persona': {
              path: '/persona',
              target: 'Persona',
              tab: 'Main',
              feedback: 'none',
              comments: false,
              editMode: 'inline'
            }
          }
        }}
        projectUser={{ valid: false, validationMessage: 'USERNAME environment variable not configured. Please set USERNAME in your config/.env file.' }}
        onSubmitFeedback={submit}
      />
    );

    expect(screen.queryByRole('button', { name: 'Submit feedback' })).not.toBeInTheDocument();
    const answer = screen.getByLabelText('answer');
    expect(answer).toHaveAttribute('rows', '1');
    expect(answer).toHaveValue('Original answer');
    expect(screen.getAllByText('inline').length).toBeGreaterThan(0);
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

    expect(screen.queryByLabelText('persona')).not.toBeInTheDocument();
    expect(screen.getByText('SME', { selector: 'output' })).toBeInTheDocument();
    expect(screen.getByText('logged', { selector: '.field-edit-mode' })).toBeInTheDocument();
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
