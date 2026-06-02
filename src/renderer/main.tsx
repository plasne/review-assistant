import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PatchDiff } from '@pierre/diffs/react';
import type {
  AgentStatusSnapshot,
  AppBootstrap,
  ChatMessage,
  ContinueWithGitHubResult,
  FeedbackConfig,
  FeedbackConfigEntry,
  FeedbackEntry,
  FeedbackHistory,
  FeedbackMode,
  FeedbackSubmissionInput,
  OpenProjectResult,
  ProjectUser,
  RecordDetail,
  RenderNode
} from '../shared/types';
import { feedbackConfigEntryForPath, FEEDBACK_MODES } from '../shared/feedback';
import './styles.css';

type Status = 'idle' | 'loading' | 'error';
type ChatState = 'ready' | 'streaming' | 'canceled' | 'error';
type ColumnKey = 'records' | 'details' | 'chat';
type NodeTab = {
  id: string;
  label: string;
  node: RenderNode;
};
type OpenNodeTab = (node: RenderNode) => void;

const MIN_COLUMN_PERCENT = 16;

const App = () => {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [project, setProject] = useState<OpenProjectResult | undefined>();
  const [record, setRecord] = useState<RecordDetail | undefined>();
  const [feedbackConfig, setFeedbackConfig] = useState<FeedbackConfig | undefined>();
  const [draftFeedbackConfig, setDraftFeedbackConfig] = useState<FeedbackConfig | undefined>();
  const [projectUser, setProjectUser] = useState<ProjectUser | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | undefined>();
  const [loginDialog, setLoginDialog] = useState<ContinueWithGitHubResult | undefined>();
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [chatState, setChatState] = useState<ChatState>('ready');
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();
  const [newProjectId, setNewProjectId] = useState('');
  const [isCreateProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [isFeedbackConfigOpen, setFeedbackConfigOpen] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | undefined>();
  const [columns, setColumns] = useState({ records: 22, details: 48, chat: 30 });
  const [recordsCollapsed, setRecordsCollapsed] = useState(false);
  const columnsRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const activeLoginIdRef = useRef<string | undefined>(undefined);
  const autoOpenRef = useRef({ project: false, record: false });
  const loginDialogTitleId = useId();

  useEffect(() => {
    activeRequestIdRef.current = activeRequestId;
  }, [activeRequestId]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  }, [messages, chatState]);

  useEffect(() => {
    window.reviewAssistant
      .getBootstrap()
      .then((result) => {
        setBootstrap(result);
        setStatus(result.configError ? 'error' : 'idle');
        setError(result.configError);
      })
      .catch((caught: Error) => {
        setStatus('error');
        setError(caught.message);
      });
  }, []);

  useEffect(() => {
    const unsubscribers = [
      window.reviewAssistant.onChatChunk((chunk) => {
        setMessages((current) =>
          current.map((message) => (message.id === chunk.messageId ? { ...message, content: `${message.content}${chunk.content}` } : message))
        );
      }),
      window.reviewAssistant.onChatComplete((complete) => {
        if (activeRequestIdRef.current !== complete.requestId) {
          return;
        }
        setChatState('ready');
        setActiveRequestId(undefined);
      }),
      window.reviewAssistant.onChatError((event) => {
        if (activeRequestIdRef.current !== event.requestId) {
          return;
        }
        setChatState('error');
        setActiveRequestId(undefined);
        if (event.error.code === 'AUTH_REQUIRED' || event.error.code === 'BINARY_NOT_FOUND' || event.error.code === 'BACKEND_UNAVAILABLE') {
          setAgentStatus({ provider: agentStatus?.provider ?? { id: 'github-copilot', name: 'GitHub Copilot' }, availability: 'unavailable', error: event.error });
        }
        const content = event.error.remediation ? `${event.error.message} ${event.error.remediation}` : event.error.message;
        setMessages((current) => {
          if (event.messageId && current.some((message) => message.id === event.messageId)) {
            return current.map((message) => (message.id === event.messageId ? { ...message, role: 'system', content } : message));
          }
          return [...current, { id: `error-${Date.now()}`, role: 'system', content, createdAt: new Date().toISOString() }];
        });
      }),
      window.reviewAssistant.onChatCanceled((event) => {
        if (activeRequestIdRef.current !== event.requestId) {
          return;
        }
        setChatState('canceled');
        setActiveRequestId(undefined);
        if (event.messageId) {
          setMessages((current) =>
            current.map((message) => (message.id === event.messageId && !message.content ? { ...message, content: 'Response canceled.' } : message))
          );
        }
      }),
      window.reviewAssistant.onGitHubLoginComplete((completion) => {
        if (completion.success) {
          void refreshAgentStatus();
        }
        if (activeLoginIdRef.current !== completion.loginId) {
          return;
        }
        activeLoginIdRef.current = undefined;
        setLoginDialog(undefined);
        if (!completion.success) {
          setStatus('error');
          setError(completion.errorMessage ?? 'GitHub Copilot login did not complete.');
        }
      })
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [agentStatus?.provider]);

  const refreshAgentStatus = async () => {
    try {
      const result = await window.reviewAssistant.getAgentStatus();
      setAgentStatus(result);
      if (result.availability === 'ready' && chatState !== 'streaming') {
        setChatState('ready');
      }
    } catch (caught) {
      setAgentStatus({
        provider: { id: 'github-copilot', name: 'GitHub Copilot' },
        availability: 'unavailable',
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: caught instanceof Error ? caught.message : String(caught),
          retryable: true,
          remediation: 'Check GitHub Copilot availability and try again.'
        }
      });
    }
  };

  const continueWithGitHub = async () => {
    setLoginInProgress(true);
    try {
      const result = await window.reviewAssistant.continueWithGitHub();
      if (result.deviceCode && result.verificationUri) {
        activeLoginIdRef.current = result.loginId;
        setLoginDialog(result);
      } else {
        void refreshAgentStatus();
      }
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoginInProgress(false);
    }
  };

  useEffect(() => {
    void refreshAgentStatus();
  }, []);

  const openProject = async (projectId: string) => {
    setSelectedProjectId(projectId);
    setProject(undefined);
    setRecord(undefined);
    setFeedbackConfig(undefined);
    setDraftFeedbackConfig(undefined);
    setRecordsCollapsed(false);
    if (!projectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const result = await window.reviewAssistant.openProject(projectId);
      setProject(result);
      setFeedbackConfig(result.feedbackConfig);
      setDraftFeedbackConfig(result.feedbackConfig);
      await refreshProjectUser(projectId);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openRecord = async (recordId: string) => {
    if (!selectedProjectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      setRecord(await window.reviewAssistant.getRecord(selectedProjectId, recordId));
      setRecordsCollapsed(true);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshProjectUser = async (projectId: string) => {
    try {
      setProjectUser(await window.reviewAssistant.getProjectUser(projectId));
    } catch (caught) {
      setProjectUser({ valid: false, validationMessage: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  useEffect(() => {
    if (bootstrap?.autoOpenFirst !== true || autoOpenRef.current.project || selectedProjectId) {
      return;
    }
    const firstProject = bootstrap.projects[0];
    if (!firstProject) {
      return;
    }
    autoOpenRef.current.project = true;
    void openProject(firstProject.id);
  }, [bootstrap, selectedProjectId]);

  useEffect(() => {
    if (bootstrap?.autoOpenFirst !== true || !autoOpenRef.current.project || autoOpenRef.current.record || record || !project) {
      return;
    }
    const firstRecord = project.records[0];
    if (!firstRecord) {
      return;
    }
    autoOpenRef.current.record = true;
    void openRecord(firstRecord.id);
  }, [bootstrap, project, record]);

  const refreshRecords = async () => {
    if (!selectedProjectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const result = await window.reviewAssistant.openProject(selectedProjectId);
      setProject(result);
      setFeedbackConfig(result.feedbackConfig);
      setDraftFeedbackConfig(result.feedbackConfig);
      if (record && !result.records.some((item) => item.id === record.recordId)) {
        setRecord(undefined);
      }
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveFeedbackConfig = async () => {
    if (!selectedProjectId || !draftFeedbackConfig) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const saved = await window.reviewAssistant.saveFeedbackConfig(selectedProjectId, draftFeedbackConfig);
      setFeedbackConfig(saved);
      setDraftFeedbackConfig(saved);
      setFeedbackConfigOpen(false);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const submitFeedback = async (input: FeedbackSubmissionInput) => {
    if (!selectedProjectId || !record) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const result = await window.reviewAssistant.submitFeedback(selectedProjectId, record.recordId, input);
      setRecord(result.record);
      await refreshProjectUser(selectedProjectId);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const projectId = newProjectId.trim();
    if (!projectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const created = await window.reviewAssistant.createProject(projectId);
      setBootstrap((current) =>
        current
          ? {
              ...current,
              projects: [...current.projects.filter((projectOption) => projectOption.id !== created.id), created].sort((a, b) =>
                a.name.localeCompare(b.name)
              )
            }
          : current
      );
      setNewProjectId('');
      setCreateProjectDialogOpen(false);
      await openProject(created.id);
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const sendChat = async (event: React.FormEvent) => {
    event.preventDefault();
    await submitChat();
  };

  const submitChat = async () => {
    const content = chatInput.trim();
    if (!content || chatState === 'streaming' || agentStatus?.availability === 'unavailable' || status === 'loading') {
      return;
    }
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString()
    };
    const assistantMessage: ChatMessage = {
      id: `assistant-pending-${Date.now()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setChatInput('');
    setChatState('streaming');
    try {
      const chatProjectId = record?.projectId ?? (selectedProjectId || undefined);
      const chatRecordId = record?.recordId;
      const response = await window.reviewAssistant.startChat(chatProjectId, chatRecordId, content);
      setActiveRequestId(response.requestId);
      setMessages((current) => current.map((message) => (message.id === assistantMessage.id ? { ...message, id: response.messageId } : message)));
    } catch (caught) {
      setChatState('error');
      setActiveRequestId(undefined);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                role: 'system',
                content: caught instanceof Error ? caught.message : String(caught)
              }
            : message
        )
      );
    }
  };

  const handleChatInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void submitChat();
  };

  const cancelChat = async () => {
    if (!activeRequestId) {
      return;
    }
    await window.reviewAssistant.cancelChat(activeRequestId);
  };

  const clearChat = () => {
    setMessages([]);
    if (chatState !== 'streaming') {
      setChatState('ready');
      setActiveRequestId(undefined);
    }
  };

  const selectedRecordId = record?.recordId;
  const records = project?.records ?? [];
  const title = useMemo(() => (project ? `${project.project.name} records` : 'Select a project'), [project]);
  const agentUnavailable = agentStatus?.availability === 'unavailable';
  const agentAuthRequired = agentUnavailable && agentStatus?.error?.code === 'AUTH_REQUIRED';
  const canSendChat = Boolean(chatInput.trim() && chatState !== 'streaming' && !agentUnavailable && status !== 'loading');
  const agentErrorText = agentStatus?.error?.remediation ? `${agentStatus.error.message} ${agentStatus.error.remediation}` : agentStatus?.error?.message;
  const recordsColumnTemplate = recordsCollapsed ? '3.25rem' : `minmax(12rem, ${columns.records}fr)`;
  const workspaceColumnTemplate = recordsCollapsed
    ? `${recordsColumnTemplate} 1px minmax(20rem, ${columns.details}fr) 0.5rem minmax(16rem, ${columns.chat}fr)`
    : `${recordsColumnTemplate} 0.5rem minmax(20rem, ${columns.details}fr) 0.5rem minmax(16rem, ${columns.chat}fr)`;

  const resizeColumns = (left: ColumnKey, right: ColumnKey, delta: number) => {
    setColumns((current) => {
      const availableGrowth = current[right] - MIN_COLUMN_PERCENT;
      const availableShrink = current[left] - MIN_COLUMN_PERCENT;
      const boundedDelta = Math.max(-availableShrink, Math.min(delta, availableGrowth));
      return {
        ...current,
        [left]: current[left] + boundedDelta,
        [right]: current[right] - boundedDelta
      };
    });
  };

  const beginResize = (left: ColumnKey, right: ColumnKey, startX: number) => {
    const width = columnsRef.current?.getBoundingClientRect().width ?? 1;
    let previousX = startX;
    const onPointerMove = (event: PointerEvent) => {
      const delta = ((event.clientX - previousX) / width) * 100;
      previousX = event.clientX;
      resizeColumns(left, right, delta);
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return (
    <div className="app">
      <header className="app-header">
        <label className="project-picker">
          <span>Project</span>
          <select
            aria-label="Current project"
            value={selectedProjectId}
            onChange={(event) => void openProject(event.target.value)}
            disabled={Boolean(bootstrap?.configError)}
          >
            <option value="">Choose a project</option>
            {(bootstrap?.projects ?? []).map((projectOption) => (
              <option key={projectOption.id} value={projectOption.id}>
                {projectOption.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="create-project-button"
          disabled={Boolean(bootstrap?.configError)}
          onClick={() => setCreateProjectDialogOpen(true)}
        >
          Create project
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!selectedProjectId || !project || !draftFeedbackConfig}
          onClick={() => setFeedbackConfigOpen(true)}
        >
          Configure
        </button>
        <div className="header-spacer" aria-hidden="true" />
        {selectedProjectId ? (
          <span className={projectUser?.valid === false ? 'username-badge invalid' : 'username-badge'} aria-label="Current feedback username">
            {projectUser === undefined
              ? 'Checking username...'
              : projectUser.valid && projectUser.username
                ? projectUser.username
                : 'USERNAME not configured'}
          </span>
        ) : null}
      </header>

      {isCreateProjectDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <h2 id="create-project-title">Create project</h2>
            <p className="modal-help">Enter a project name using lowercase letters, numbers, and hyphens.</p>
            <form className="new-project-form" onSubmit={(event) => void createProject(event)}>
              <label htmlFor="new-project-name">Project name</label>
              <input
                id="new-project-name"
                autoFocus
                value={newProjectId}
                onChange={(event) => setNewProjectId(event.target.value)}
                placeholder="new-project"
                pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]"
                title="Use 3-63 lowercase letters, numbers, and hyphens."
              />
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setNewProjectId('');
                    setCreateProjectDialogOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="create-project-button" disabled={!newProjectId.trim()}>
                  Create
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isFeedbackConfigOpen && draftFeedbackConfig ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal feedback-config-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-config-title">
            <h2 id="feedback-config-title">Feedback configuration</h2>
            <FeedbackConfigTable config={draftFeedbackConfig} onChange={setDraftFeedbackConfig} />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setFeedbackConfigOpen(false)}>
                Cancel
              </button>
              <button type="button" className="create-project-button" onClick={() => void saveFeedbackConfig()}>
                Save
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {status === 'error' && error ? (
        <section className="error-panel" role="alert" tabIndex={0}>
          {error}
        </section>
      ) : null}

      <main
        ref={columnsRef}
        className="columns"
        aria-label="Review workspace"
        style={{
          gridTemplateColumns: workspaceColumnTemplate
        }}
      >
        <section className={recordsCollapsed ? 'column records collapsed' : 'column records'} aria-labelledby="record-list-heading" tabIndex={0}>
          <div className="records-header">
            <button
              type="button"
              className="records-collapse-button"
              aria-label={recordsCollapsed ? 'Expand records sidebar' : 'Collapse records sidebar'}
              aria-expanded={!recordsCollapsed}
              aria-controls="records-list-panel"
              title={recordsCollapsed ? 'Expand records sidebar' : 'Collapse records sidebar'}
              onClick={() => setRecordsCollapsed((current) => !current)}
            >
              <RecordsQueueIcon />
            </button>
            <h2 id="record-list-heading">{title}</h2>
            {recordsCollapsed ? null : (
              <button
                type="button"
                className="refresh-records-button"
                aria-label="Refresh records"
                title="Refresh records"
                disabled={!selectedProjectId || status === 'loading'}
                onClick={() => void refreshRecords()}
              >
                Refresh
              </button>
            )}
          </div>
          {recordsCollapsed ? null : (
            <div id="records-list-panel" className="records-list-container" role="region" aria-label="Records list" tabIndex={0}>
              {records.length === 0 ? <p className="empty">No records loaded.</p> : null}
              <ul aria-label="Records">
                {records.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === selectedRecordId ? 'selected record-button' : 'record-button'}
                      onClick={() => void openRecord(item.id)}
                    >
                      {item.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {recordsCollapsed ? (
          <div className="column-divider" aria-hidden="true" />
        ) : (
          <ColumnResizer
            label="Resize records and details columns"
            onResize={(delta) => resizeColumns('records', 'details', delta)}
            onPointerResize={(startX) => beginResize('records', 'details', startX)}
          />
        )}

        <section className="column details" aria-labelledby="details-heading" tabIndex={0}>
          <h2 id="details-heading">Record details</h2>
          {status === 'loading' ? <p aria-live="polite">Loading...</p> : null}
          {record ? (
            <RecordDetails record={record} feedbackConfig={feedbackConfig} projectUser={projectUser} onSubmitFeedback={submitFeedback} />
          ) : (
            <p className="empty">Choose a record to inspect read-only details.</p>
          )}
        </section>

        <ColumnResizer
          label="Resize details and chat columns"
          onResize={(delta) => resizeColumns('details', 'chat', delta)}
          onPointerResize={(startX) => beginResize('details', 'chat', startX)}
        />

        <section className="column chat" aria-label="GitHub Copilot chat" tabIndex={0}>
          {agentUnavailable ? (
            <div className="agent-status error" role="status" aria-live="polite">
              <span>{agentErrorText ?? 'GitHub Copilot is unavailable.'}</span>
              {agentAuthRequired ? (
                <button
                  type="button"
                  className="github-login-button"
                  onClick={() => void continueWithGitHub()}
                  disabled={chatState === 'streaming' || loginInProgress}
                >
                  <GitHubLogo />
                  Continue with GitHub
                </button>
              ) : null}
              <button type="button" className="secondary-button" onClick={() => void refreshAgentStatus()} disabled={chatState === 'streaming'}>
                Check again
              </button>
            </div>
          ) : null}
          <div ref={messagesRef} className="messages" role="region" aria-label="Chat messages" aria-live="polite" tabIndex={0}>
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message ${message.role}${message.role === 'assistant' && !message.content && chatState === 'streaming' ? ' pending' : ''}`}
              >
                <strong>{message.role}</strong>
                <ChatMessageContent
                  content={
                    message.role === 'assistant' && !message.content && chatState === 'streaming'
                      ? 'Working'
                      : message.content || 'Response canceled.'
                  }
                />
              </article>
            ))}
          </div>
          <form className="chat-form" onSubmit={(event) => void sendChat(event)}>
            <label htmlFor="chat-input">Message GitHub Copilot</label>
            <textarea
              id="chat-input"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={handleChatInputKeyDown}
              disabled={agentUnavailable || chatState === 'streaming'}
              rows={4}
            />
            <div className="chat-actions">
              <button
                type="button"
                className="github-login-button"
                onClick={() => void continueWithGitHub()}
                disabled={chatState === 'streaming' || loginInProgress}
              >
                <GitHubLogo />
                {loginInProgress ? 'Waiting...' : 'Login'}
              </button>
              <button type="submit" disabled={!canSendChat}>
                Send
              </button>
              <button type="button" className="secondary-button" onClick={clearChat} disabled={messages.length === 0 || chatState === 'streaming'}>
                Clear
              </button>
              <button type="button" className="secondary-button" disabled={chatState !== 'streaming'} onClick={() => void cancelChat()}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      </main>

      {loginDialog?.deviceCode && loginDialog.verificationUri ? (
        <div className="modal-backdrop">
          <section className="login-modal" role="dialog" aria-modal="true" aria-labelledby={loginDialogTitleId}>
            <h2 id={loginDialogTitleId}>Login to GitHub Copilot</h2>
            <p>Enter this device code at {loginDialog.verificationUri}:</p>
            <div className="device-code" aria-label="GitHub Copilot device code">
              {loginDialog.deviceCode}
            </div>
            {loginDialog.copiedToClipboard ? <p className="clipboard-status">Copied to clipboard</p> : null}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  activeLoginIdRef.current = undefined;
                  setLoginDialog(undefined);
                }}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <footer className="app-footer">Version {bootstrap?.version ?? 'loading'}</footer>
    </div>
  );
};

const ColumnResizer = ({
  label,
  onResize,
  onPointerResize
}: {
  label: string;
  onResize: (delta: number) => void;
  onPointerResize: (startX: number) => void;
}) => (
  <button
    type="button"
    className="column-resizer"
    aria-label={label}
    aria-orientation="vertical"
    role="separator"
    onPointerDown={(event) => {
      event.preventDefault();
      onPointerResize(event.clientX);
    }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onResize(-2);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onResize(2);
      }
    }}
  />
);

const GitHubLogo = () => (
  <svg className="github-logo" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.87c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
    />
  </svg>
);

const ChatMessageContent = ({ content }: { content: string }) => <div className="message-content">{renderMarkdown(content)}</div>;

const renderMarkdown = (content: string): React.ReactNode[] => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      blocks.push(
        <pre key={`code-${index}`} className="markdown-code-block">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = parseTableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(parseTableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <table key={`table-${index}`}>
          <thead>
            <tr>
              {headers.map((header, cellIndex) => (
                <th key={`${header}-${cellIndex}`}>{renderInlineMarkdown(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {headers.map((_header, cellIndex) => (
                  <td key={`cell-${cellIndex}`}>{renderInlineMarkdown(row[cellIndex] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    const unorderedItems = readList(lines, index, /^[-*]\s+/);
    if (unorderedItems.items.length > 0) {
      index = unorderedItems.nextIndex;
      blocks.push(
        <ul key={`ul-${index}`}>
          {unorderedItems.items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const orderedItems = readList(lines, index, /^\d+\.\s+/);
    if (orderedItems.items.length > 0) {
      index = orderedItems.nextIndex;
      blocks.push(
        <ol key={`ol-${index}`}>
          {orderedItems.items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !lines[index].trim().startsWith('```') &&
      !isTableStart(lines, index) &&
      readList(lines, index, /^[-*]\s+/).items.length === 0 &&
      readList(lines, index, /^\d+\.\s+/).items.length === 0
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraphLines.join(' '))}</p>);
  }

  return blocks;
};

const isTableStart = (lines: string[], index: number): boolean => isTableRow(lines[index]) && Boolean(lines[index + 1]?.match(tableSeparatorPattern));

const isTableRow = (line: string): boolean => line.includes('|') && parseTableCells(line).length > 1;

const tableSeparatorPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

const parseTableCells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
};

const readList = (lines: string[], index: number, marker: RegExp): { items: string[]; nextIndex: number } => {
  const items: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length && marker.test(lines[nextIndex].trim())) {
    items.push(lines[nextIndex].trim().replace(marker, ''));
    nextIndex += 1;
  }
  return { items, nextIndex };
};

const renderInlineMarkdown = (content: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }
  return nodes;
};

const FeedbackConfigTable = ({ config, onChange }: { config: FeedbackConfig; onChange: (config: FeedbackConfig) => void }) => {
  const entries = Object.values(config.properties);
  const updateEntry = (path: string, patch: Partial<FeedbackConfigEntry>) => {
    onChange({
      properties: {
        ...config.properties,
        [path]: { ...config.properties[path], ...patch }
      }
    });
  };

  return (
    <div className="feedback-config-table-wrap">
      <table className="feedback-config-table">
        <thead>
          <tr>
            <th>TARGET</th>
            <th>FEEDBACK</th>
            <th>COMMENT</th>
            <th>EDITABLE</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.path}>
              <td>{entry.target}</td>
              <td>
                <select
                  aria-label={`${entry.target} feedback mode`}
                  value={entry.feedback}
                  onChange={(event) => updateEntry(entry.path, { feedback: event.target.value as FeedbackMode })}
                >
                  {FEEDBACK_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </td>
              <td className="checkbox-cell">
                <input
                  aria-label={`${entry.target} comment`}
                  type="checkbox"
                  checked={entry.comments}
                  onChange={(event) => updateEntry(entry.path, { comments: event.target.checked })}
                />
              </td>
              <td className="checkbox-cell">
                <input
                  aria-label={`${entry.target} editable`}
                  type="checkbox"
                  disabled={!entry.supportsEdit}
                  checked={entry.editable}
                  onChange={(event) => updateEntry(entry.path, { editable: entry.supportsEdit && event.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const RecordDetails = ({
  record,
  feedbackConfig,
  projectUser,
  onSubmitFeedback
}: {
  record: RecordDetail;
  feedbackConfig: FeedbackConfig | undefined;
  projectUser: ProjectUser | undefined;
  onSubmitFeedback: (input: FeedbackSubmissionInput) => Promise<void>;
}) => {
  const [nodeTabs, setNodeTabs] = useState<NodeTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('all');
  const history = record.feedbackHistory ?? {};
  const activeNodeTab = nodeTabs.find((tab) => tab.id === activeTabId);

  useEffect(() => {
    const evidenceTabs = collectEvidenceNodeTabs(record.renderTree);
    setNodeTabs(evidenceTabs);
    setActiveTabId('all');
  }, [record.projectId, record.recordId, record.renderTree]);

  const openNodeTab: OpenNodeTab = (node) => {
    const id = nodeTabId(node);
    setNodeTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, { id, label: nodeTabLabel(node), node }]));
    setActiveTabId(id);
  };

  const closeNodeTab = (tabId: string) => {
    setNodeTabs((current) => current.filter((tab) => tab.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId('all');
    }
  };

  return (
    <div>
      <div className="node-tabs" role="tablist" aria-label="Record detail tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTabId === 'all'}
          className={activeTabId === 'all' ? 'node-tab active' : 'node-tab'}
          onClick={() => setActiveTabId('all')}
        >
          Overview
        </button>
        {nodeTabs.map((tab) => (
          <span key={tab.id} className={activeTabId === tab.id ? 'node-tab-wrap active' : 'node-tab-wrap'}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTabId === tab.id}
              className="node-tab"
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
            <button
              type="button"
              className="node-tab-close"
              aria-label={`Close ${tab.label} tab`}
              title={`Close ${tab.label} tab`}
              onClick={() => closeNodeTab(tab.id)}
            >
              <CloseIcon />
            </button>
          </span>
        ))}
      </div>
      {record.validationIssues.length > 0 ? (
        <section className="validation" aria-label="Validation errors">
          <h3>Validation errors</h3>
          <ul>
            {record.validationIssues.map((issue, index) => (
              <li key={`${issue.path}-${issue.keyword}-${index}`}>
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="valid">Record passes schema validation.</p>
      )}
      <div className="node-tab-panel" role="tabpanel">
        {activeNodeTab ? (
          <RenderTree
            node={activeNodeTab.node}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            onOpenTab={openNodeTab}
          />
        ) : (
          <RenderTreeRoot
            node={record.renderTree}
            collapseEvidence
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            onOpenTab={openNodeTab}
          />
        )}
      </div>
    </div>
  );
};

const RenderTreeRoot = ({
  node,
  collapseEvidence = false,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback,
  onOpenTab
}: {
  node: RenderNode;
  collapseEvidence?: boolean;
  feedbackConfig?: FeedbackConfig;
  history: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback: (input: FeedbackSubmissionInput) => Promise<void>;
  onOpenTab?: OpenNodeTab;
}) => {
  if (node.kind === 'object') {
    return (
      <>
        {node.description ? <p>{node.description}</p> : null}
        {node.children.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            collapseEvidence={collapseEvidence}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            onOpenTab={onOpenTab}
          />
        ))}
      </>
    );
  }
  return (
    <RenderTree
      node={node}
      collapseEvidence={collapseEvidence}
      feedbackConfig={feedbackConfig}
      history={history}
      projectUser={projectUser}
      onSubmitFeedback={onSubmitFeedback}
      onOpenTab={onOpenTab}
    />
  );
};

const RenderTree = ({
  node,
  collapseObject = false,
  collapseEvidence = false,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback,
  onOpenTab,
  disableNodeActions = false
}: {
  node: RenderNode;
  collapseObject?: boolean;
  collapseEvidence?: boolean;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  onOpenTab?: OpenNodeTab;
  disableNodeActions?: boolean;
}) => {
  const issues = node.validationIssues.length > 0 ? (
    <ul className="field-errors">
      {node.validationIssues.map((issue, index) => (
        <li key={`${issue.keyword}-${index}`}>{issue.message}</li>
      ))}
    </ul>
  ) : null;

  if (node.kind === 'object') {
    if (collapseObject) {
      const identifier = getObjectIdentifier(node);
      return (
        <details className="node collapsible-node">
          <summary>
            <span className="field-heading array-item-summary">
              {node.description ? <span className="field-description">{node.description}</span> : null}
              <span className="array-item-identifier">{identifier ?? node.label}</span>
            </span>
          </summary>
          {issues}
          {node.children.map((child) => (
            <RenderTree
              key={child.path ?? child.label}
              node={child}
              collapseEvidence={collapseEvidence}
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              onSubmitFeedback={onSubmitFeedback}
              onOpenTab={onOpenTab}
              disableNodeActions={disableNodeActions}
            />
          ))}
        </details>
      );
    }
    return (
      <section className="node">
        <NodeHeading node={node} />
        {issues}
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
        {node.children.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            collapseEvidence={collapseEvidence}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            onOpenTab={onOpenTab}
            disableNodeActions={disableNodeActions}
          />
        ))}
      </section>
    );
  }
  if (node.kind === 'array') {
    if (node.presentation === 'evidence-list') {
      return (
        <EvidenceList
          node={node}
          issues={issues}
          collapseItems={collapseEvidence}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          onSubmitFeedback={onSubmitFeedback}
          onOpenTab={disableNodeActions ? undefined : onOpenTab}
          disableNodeActions={disableNodeActions}
        />
      );
    }
    return (
      <section className="node array-node">
        <NodeHeading node={node} meta={formatItemCount(node.items.length)} />
        {issues}
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
        {node.items.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            collapseObject={child.kind === 'object'}
            collapseEvidence={collapseEvidence}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            onOpenTab={onOpenTab}
            disableNodeActions={disableNodeActions}
          />
        ))}
      </section>
    );
  }
  if (node.kind === 'raw') {
    if (isCollapsiblePresentation(node.presentation)) {
      return (
        <CollapsiblePresentationField node={node}>
          <p className="raw-reason">{node.reason}</p>
          <pre className={presentationOutputClassName(node.presentation)}>{JSON.stringify(node.value, null, 2)}</pre>
          <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
        </CollapsiblePresentationField>
      );
    }
    return (
      <section className={fieldClassName(node.presentation)}>
        <NodeHeading node={node} />
        {issues}
        <p className="raw-reason">{node.reason}</p>
        <pre className={presentationOutputClassName(node.presentation)}>{JSON.stringify(node.value, null, 2)}</pre>
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
      </section>
    );
  }
  if (isCollapsiblePresentation(node.presentation)) {
    return (
      <CollapsiblePresentationField node={node}>
        {issues}
        {node.enumValues ? <EnumValue node={node} /> : <output className={presentationOutputClassName(node.presentation)}>{formatValue(node.value)}</output>}
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
      </CollapsiblePresentationField>
    );
  }
  return (
    <section className={fieldClassName(node.presentation)}>
      <NodeHeading node={node} />
      {issues}
      {node.presentation === 'diff-view' ? (
        <DiffView node={node} history={history} />
      ) : node.enumValues ? (
        <EnumValue node={node} />
      ) : (
        <output className={presentationOutputClassName(node.presentation)}>{formatValue(node.value)}</output>
      )}
      <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
    </section>
  );
};

const fieldClassName = (presentation: RenderNode['presentation']): string =>
  presentation ? `field presentation-field presentation-${presentation}` : 'field';

const presentationOutputClassName = (presentation: RenderNode['presentation']): string | undefined => (presentation ? 'presentation-output' : undefined);

const isCollapsiblePresentation = (presentation: RenderNode['presentation']): boolean => presentation === 'chat-request' || presentation === 'chat-response';

const CollapsiblePresentationField = ({ node, children }: { node: RenderNode; children: React.ReactNode }) => (
  <details className={fieldClassName(node.presentation)} open>
    <summary>
      <FieldHeading label={node.label} description={node.description} />
    </summary>
    {children}
  </details>
);

const EvidenceList = ({
  node,
  issues,
  collapseItems = false,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback,
  onOpenTab,
  disableNodeActions = false
}: {
  node: Extract<RenderNode, { kind: 'array' }>;
  issues: React.ReactNode;
  collapseItems?: boolean;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  onOpenTab?: OpenNodeTab;
  disableNodeActions?: boolean;
}) => {
  return (
    <details className="node array-node evidence-list" open>
      <summary className="node-heading-row">
        <FieldHeading label={node.label} description={node.description} meta={formatItemCount(node.items.length)} />
        {disableNodeActions ? null : (
          <div className="node-heading-actions">
            {onOpenTab ? (
              <OpenInTabButton onClick={() => onOpenTab(node)} />
            ) : null}
          </div>
        )}
      </summary>
      {issues}
      <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
      <div className="evidence-items">
        {node.items.map((item, index) =>
          item.kind === 'object' ? (
            <EvidenceCard
              key={item.path ?? item.label}
              node={item}
              index={index}
              collapsed={collapseItems}
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              onSubmitFeedback={onSubmitFeedback}
            />
          ) : (
            <RenderTree
              key={item.path ?? item.label}
              node={item}
              collapseEvidence={collapseItems}
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              onSubmitFeedback={onSubmitFeedback}
              onOpenTab={onOpenTab}
              disableNodeActions={disableNodeActions}
            />
          )
        )}
      </div>
    </details>
  );
};

const EvidenceCard = ({
  node,
  index,
  collapsed = false,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback
}: {
  node: Extract<RenderNode, { kind: 'object' }>;
  index: number;
  collapsed?: boolean;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
}) => {
  const source = evidenceChildText(node, 'source');
  const id = evidenceChildText(node, 'id');
  const fields = node.children.map((child) => ({ node: child, editable: evidenceFieldIsEditable(child, feedbackConfig) }));
  const readonlyFields = fields.filter((field) => !field.editable);
  const editableFields = fields.filter((field) => field.editable);
  return (
    <details className="evidence-card" open={!collapsed}>
      <summary className="evidence-card-header">
        <h4>{source ?? `Evidence ${index + 1}`}</h4>
        {id ? <span className="evidence-id">{id}</span> : null}
      </summary>
      {readonlyFields.length > 0 ? (
        <dl className="evidence-readonly-grid" aria-label="Read-only evidence fields">
          {readonlyFields.map(({ node: child }) => (
           <EvidenceField
             key={child.path ?? child.label}
             node={child}
             feedbackConfig={feedbackConfig}
             history={history}
             projectUser={projectUser}
             onSubmitFeedback={onSubmitFeedback}
           />
          ))}
        </dl>
      ) : null}
      {editableFields.length > 0 ? (
        <dl className="evidence-editable-fields" aria-label="Editable evidence fields">
          {editableFields.map(({ node: child }) => (
          <EvidenceField
            key={child.path ?? child.label}
            node={child}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
          />
          ))}
        </dl>
      ) : null}
    </details>
  );
};

const EvidenceField = ({
  node,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback
}: {
  node: RenderNode;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
}) => {
  const editable = evidenceFieldIsEditable(node, feedbackConfig);
  return (
    <div className={`evidence-field ${editable ? 'editable' : 'readonly'}`}>
      <dt>
        <span>{node.label}</span>
        <span className={`editability-badge ${editable ? 'editable' : 'readonly'}`}>{editable ? 'Editable' : 'Read-only'}</span>
      </dt>
      {editable ? null : (
        <dd>
          {node.presentation === 'diff-view' && (node.kind === 'value' || node.kind === 'raw') ? (
            <DiffView node={node} history={history} />
          ) : node.kind === 'value' || node.kind === 'raw' ? (
            formatValue(node.value)
          ) : (
            <RenderTree node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
          )}
        </dd>
      )}
      <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} showEditDiff={editable} />
    </div>
  );
};

const evidenceFieldIsEditable = (node: RenderNode, feedbackConfig?: FeedbackConfig): boolean => {
  const config = node.path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, node.path) : undefined;
  return config?.editable === true;
};

const evidenceChildText = (node: Extract<RenderNode, { kind: 'object' }>, label: string): string | undefined => {
  const child = node.children.find((item) => item.label === label);
  return child && (child.kind === 'value' || child.kind === 'raw') ? formatValue(child.value) : undefined;
};

const FieldHeading = ({ label, description, meta }: { label: string; description?: string; meta?: string }) => (
  <h3 className="field-heading">
    <span className="field-label">{label}</span>
    {description ? <span className="field-description">{description}</span> : null}
    {meta ? <span className="field-meta">{meta}</span> : null}
  </h3>
);

const NodeHeading = ({ node, meta, onOpenTab }: { node: RenderNode; meta?: string; onOpenTab?: OpenNodeTab }) => (
  <div className="node-heading-row">
    <FieldHeading label={node.label} description={node.description} meta={meta} />
    {onOpenTab ? (
      <div className="node-heading-actions">
        <OpenInTabButton onClick={() => onOpenTab(node)} />
      </div>
    ) : null}
  </div>
);

const RecordsQueueIcon = () => (
  <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="2" y="2" width="4" height="12" rx="1" fill="currentColor" stroke="none" opacity="0.5" />
    <line x1="8" y1="4" x2="14" y2="4" />
    <line x1="8" y1="8" x2="14" y2="8" />
    <line x1="8" y1="12" x2="14" y2="12" />
  </svg>
);

const OpenInTabButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    className="secondary-button compact-button icon-button"
    aria-label="Open in tab"
    title="Open in tab"
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    }}
  >
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 5L2 3Q2 2 3 2L6 2Q7 2 7 3L7 5L13 5Q14 5 14 6L14 13Q14 14 13 14L3 14Q2 14 2 13Z" />
      <path d="M8 7.5V11.5M6 9.5H10" />
    </svg>
  </button>
);

const CloseIcon = () => (
  <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 4L12 12M12 4L4 12" />
  </svg>
);

const FeedbackPanel = ({
  node,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback,
  showEditDiff = false
}: {
  node: RenderNode;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  showEditDiff?: boolean;
}) => {
  const path = node.path;
  const config = path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, path) : undefined;
  const nodeHistory = path ? history?.[path] : undefined;
  const initialEditValue = editableValue(node);
  const [feedbackValue, setFeedbackValue] = useState('');
  const [commentValue, setCommentValue] = useState('');
  const [editValue, setEditValue] = useState(initialEditValue);
  useEffect(() => {
    setEditValue(initialEditValue);
  }, [initialEditValue, path]);
  if (!path || !config || !onSubmitFeedback) {
    return null;
  }
  const allHistory = collectHistory(nodeHistory);
  const hasFeedbackControls = config.feedback !== 'none' || config.comments || config.editable;
  const usernameValid = projectUser?.valid === true;
  const showFeedbackControls = hasFeedbackControls && usernameValid;
  if (!showFeedbackControls && allHistory.length === 0) {
    return null;
  }
  const editChanged = editValue.trim() !== initialEditValue.trim();
  const canSubmit = Boolean(feedbackValue.trim() || commentValue.trim() || editChanged);

  return (
    <section className="feedback-panel" aria-label={`${node.label} feedback`}>
      {showFeedbackControls && config.feedback !== 'none' ? (
        <FeedbackValueInput mode={config.feedback} label={node.label} value={feedbackValue} onChange={setFeedbackValue} />
      ) : null}
      {showFeedbackControls && config.editable ? (
        <label className="feedback-input">
          Edit
          <EditInput node={node} value={editValue} onChange={setEditValue} />
          {showEditDiff ? <EditDiff original={nodeHistory?.original ?? initialEditValue} edited={editValue} /> : null}
        </label>
      ) : null}
      {showFeedbackControls && config.comments ? (
        <label className="feedback-input">
          Comment
          <textarea value={commentValue} onChange={(event) => setCommentValue(event.target.value)} rows={2} />
        </label>
      ) : null}
      {showFeedbackControls ? (
        <button
          type="button"
          className="secondary-button"
          disabled={!canSubmit}
          onClick={() => {
            void onSubmitFeedback({
              propertyPath: path,
              feedbackValue: feedbackValue || undefined,
              commentValue: commentValue || undefined,
              editValue: editChanged ? editValue : undefined
            }).then(() => {
              setFeedbackValue('');
              setCommentValue('');
              setEditValue(initialEditValue);
            });
          }}
        >
          Submit feedback
        </button>
      ) : null}
      {allHistory.length > 0 ? (
        <details className="feedback-history">
          <summary>History ({allHistory.length})</summary>
          {allHistory.map((entry) => (
            <article key={`${entry.timestamp}-${entry.username}-${entry.feedback ?? ''}-${entry.comment ?? ''}-${entry.edit ?? ''}-${entry.original ?? ''}`} className="history-entry">
              {entry.original ? (
                <p className="history-line">
                  <strong>original:</strong>
                  <span>{entry.original}</span>
                </p>
              ) : null}
              {entry.feedback ? (
                <p className="history-line">
                  <strong>feedback:</strong>
                  <span>{entry.feedback}</span>
                </p>
              ) : null}
              {entry.comment ? (
                <p className="history-line">
                  <strong>comment:</strong>
                  <span>{entry.comment}</span>
                </p>
              ) : null}
              {entry.edit ? (
                <p className="history-line">
                  <strong>edit:</strong>
                  <span>{entry.edit}</span>
                </p>
              ) : null}
              {entry.username ? (
                <small>
                  {entry.username} - {formatRelativeTime(entry.timestamp)}
                </small>
              ) : null}
            </article>
          ))}
        </details>
      ) : null}
    </section>
  );
};

const EditDiff = ({ original, edited }: { original: string; edited: string }) => {
  if (original === edited) {
    return <p className="edit-diff-empty">No edits yet.</p>;
  }
  if (!supportsRichDiff()) {
    return <SimpleDiff original={original} edited={edited} />;
  }
  return (
    <div className="edit-diff" aria-label="Edit diff">
      <p className="edit-diff-title">Diff preview</p>
      <PatchDiff
        patch={createFieldPatch(original, edited)}
        disableWorkerPool
        options={{
          diffStyle: 'unified',
          disableFileHeader: true,
          disableLineNumbers: true,
          diffIndicators: 'classic',
          overflow: 'wrap',
          theme: 'pierre-dark-soft',
          themeType: 'dark'
        }}
      />
    </div>
  );
};

const SimpleDiff = ({ original, edited }: { original: string; edited: string }) => (
  <div className="edit-diff" aria-label="Edit diff">
    <p className="edit-diff-title">Diff preview</p>
    {splitPatchLines(original).map((line, index) => (
      <div key={`removed-${index}`} className="edit-diff-line removed">
        <span>-</span>
        <del>{line}</del>
      </div>
    ))}
    {splitPatchLines(edited).map((line, index) => (
      <div key={`added-${index}`} className="edit-diff-line added">
        <span>+</span>
        <ins>{line}</ins>
      </div>
    ))}
  </div>
);

const supportsRichDiff = (): boolean => typeof CSSStyleSheet !== 'undefined' && typeof CSSStyleSheet.prototype.replaceSync === 'function';

const DiffView = ({ node, history }: { node: Extract<RenderNode, { kind: 'value' | 'raw' }>; history?: Record<string, FeedbackHistory> }) => {
  const currentValue = formatValue(node.value);
  const originalValue = node.path ? history?.[node.path]?.original : undefined;
  return <EditDiff original={originalValue ?? currentValue} edited={currentValue} />;
};

const createFieldPatch = (original: string, edited: string): string => {
  const originalLines = splitPatchLines(original);
  const editedLines = splitPatchLines(edited);
  return [
    'diff --git a/evidence-content.txt b/evidence-content.txt',
    '--- a/evidence-content.txt',
    '+++ b/evidence-content.txt',
    `@@ -1,${originalLines.length} +1,${editedLines.length} @@`,
    ...originalLines.map((line) => `-${line}`),
    ...editedLines.map((line) => `+${line}`)
  ].join('\n');
};

const splitPatchLines = (value: string): string[] => {
  const lines = value.split(/\r?\n/);
  return lines.length > 0 ? lines : [''];
};

const FeedbackValueInput = ({
  mode,
  label,
  value,
  onChange
}: {
  mode: FeedbackMode;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const groupName = useId();
  const options =
    mode === 'good_fair_bad'
      ? [
          { value: 'good', label: 'Good' },
          { value: 'fair', label: 'Fair' },
          { value: 'bad', label: 'Bad' }
        ]
      : mode === 'thumbs'
        ? [
            { value: 'thumbs_up', label: '👍' },
            { value: 'thumbs_down', label: '👎' }
          ]
        : ['1', '2', '3', '4', '5'].map((rating) => ({ value: rating, label: '★'.repeat(Number(rating)) }));
  return (
    <fieldset className="feedback-input feedback-options" aria-label={`${label} feedback value`}>
      <div className="feedback-option-list">
        {options.map((option) => (
          <label key={option.value} className="feedback-option">
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={value === option.value}
              onChange={(event) => onChange(event.target.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
};

const EditInput = ({ node, value, onChange }: { node: RenderNode; value: string; onChange: (value: string) => void }) => {
  if (node.kind === 'value' && node.enumValues) {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {node.enumValues.map((option) => (
          <option key={enumOptionValue(option)} value={formatValue(option)}>
            {formatValue(option)}
          </option>
        ))}
      </select>
    );
  }
  return <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} />;
};

const editableValue = (node: RenderNode): string => (node.kind === 'value' ? formatValue(node.value) : '');

const collectHistory = (
  history: FeedbackHistory | undefined
): Array<{ username: string; timestamp: string; feedback?: string; comment?: string; edit?: string; original?: string }> => {
  const items = new Map<string, { username: string; timestamp: string; feedback?: string; comment?: string; edit?: string; original?: string }>();
  const upsert = (entry: FeedbackEntry, patch: { feedback?: string; comment?: string; edit?: string }) => {
    const key = `${entry.username}\u0000${entry.timestamp}`;
    items.set(key, { ...items.get(key), username: entry.username, timestamp: entry.timestamp, ...patch });
  };
  for (const entry of history?.feedback ?? []) {
    upsert(entry, { feedback: entry.value });
  }
  for (const entry of history?.comments ?? []) {
    upsert(entry, { comment: entry.value });
  }
  for (const entry of history?.edits ?? []) {
    upsert(entry, { edit: entry.value });
  }
  const sorted = [...items.values()].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  return history?.original !== undefined ? [...sorted, { username: '', timestamp: '', original: history.original }] : sorted;
};

const formatRelativeTime = (timestamp: string): string => {
  const elapsedMs = Date.now() - Date.parse(timestamp);
  const absMs = Math.abs(elapsedMs);
  const units: Array<[number, string]> = [
    [86400000, 'day'],
    [3600000, 'hour'],
    [60000, 'minute']
  ];
  for (const [unitMs, unitName] of units) {
    if (absMs >= unitMs) {
      const count = Math.max(1, Math.round(absMs / unitMs));
      return `${count} ${unitName}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
};

const getObjectIdentifier = (node: Extract<RenderNode, { kind: 'object' }>): string | undefined => {
  const [firstChild] = node.children;
  if (!firstChild) {
    return undefined;
  }
  if (firstChild.kind === 'value' || firstChild.kind === 'raw') {
    return formatValue(firstChild.value);
  }
  return firstChild.label;
};

const EnumValue = ({ node }: { node: Extract<RenderNode, { kind: 'value' }> }) => {
  const value = formatValue(node.value);
  const enumOptions = node.enumValues ?? [];
  const selectedOption = enumOptions.find((option) => formatValue(option) === value);
  const selectedValue = selectedOption === undefined ? enumOptionValue(value) : enumOptionValue(selectedOption);
  const hasSelectedOption = selectedOption !== undefined;

  return (
    <select
      aria-label={node.label}
      className="enum-select"
      value={selectedValue}
      onChange={(event) => {
        event.currentTarget.value = selectedValue;
      }}
    >
      {hasSelectedOption ? null : <option value={selectedValue}>{value} (not allowed)</option>}
      {enumOptions.map((value) => (
        <option key={enumOptionValue(value)} value={enumOptionValue(value)}>
          {formatValue(value)}
        </option>
      ))}
    </select>
  );
};

const enumOptionValue = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
};

const formatItemCount = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'}`;

const collectEvidenceNodeTabs = (node: RenderNode): NodeTab[] => {
  const tabs: NodeTab[] = [];
  const visit = (current: RenderNode) => {
    if (current.presentation === 'evidence-list') {
      tabs.push({ id: nodeTabId(current), label: nodeTabLabel(current), node: current });
      return;
    }
    if (current.kind === 'object') {
      current.children.forEach(visit);
    }
    if (current.kind === 'array') {
      current.items.forEach(visit);
    }
  };
  visit(node);
  return tabs;
};

const nodeTabId = (node: RenderNode): string => node.path || node.label;

const nodeTabLabel = (node: RenderNode): string => {
  const pathPrefix = node.path ? `${node.path} ` : '';
  return `${node.label}${pathPrefix ? ` (${pathPrefix.trim()})` : ''}`;
};

const formatValue = (value: unknown): string => {
  if (value === undefined) {
    return '(missing)';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

export { App, RenderTree };
