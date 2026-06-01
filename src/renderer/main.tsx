import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AgentStatusSnapshot,
  AppBootstrap,
  ChatMessage,
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
  const [chatState, setChatState] = useState<ChatState>('ready');
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();
  const [newProjectId, setNewProjectId] = useState('');
  const [isCreateProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [isFeedbackConfigOpen, setFeedbackConfigOpen] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | undefined>();
  const [columns, setColumns] = useState({ records: 22, details: 48, chat: 30 });
  const columnsRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeRequestIdRef = useRef<string | undefined>(undefined);

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

  useEffect(() => {
    void refreshAgentStatus();
  }, []);

  const openProject = async (projectId: string) => {
    setSelectedProjectId(projectId);
    setProject(undefined);
    setRecord(undefined);
    setFeedbackConfig(undefined);
    setDraftFeedbackConfig(undefined);
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
  const canSendChat = Boolean(chatInput.trim() && chatState !== 'streaming' && !agentUnavailable && status !== 'loading');
  const agentErrorText = agentStatus?.error?.remediation ? `${agentStatus.error.message} ${agentStatus.error.remediation}` : agentStatus?.error?.message;

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
          gridTemplateColumns: `minmax(12rem, ${columns.records}fr) 0.5rem minmax(20rem, ${columns.details}fr) 0.5rem minmax(16rem, ${columns.chat}fr)`
        }}
      >
        <section className="column records" aria-labelledby="record-list-heading" tabIndex={0}>
          <div className="records-header">
            <h2 id="record-list-heading">{title}</h2>
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
          </div>
          <div className="records-list-container" role="region" aria-label="Records list" tabIndex={0}>
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
        </section>

        <ColumnResizer
          label="Resize records and details columns"
          onResize={(delta) => resizeColumns('records', 'details', delta)}
          onPointerResize={(startX) => beginResize('records', 'details', startX)}
        />

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
}) => (
  <div>
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
    <RenderTreeRoot
      node={record.renderTree}
      feedbackConfig={feedbackConfig}
      history={record.feedbackHistory ?? {}}
      projectUser={projectUser}
      onSubmitFeedback={onSubmitFeedback}
    />
  </div>
);

const RenderTreeRoot = ({
  node,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback
}: {
  node: RenderNode;
  feedbackConfig?: FeedbackConfig;
  history: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback: (input: FeedbackSubmissionInput) => Promise<void>;
}) => {
  if (node.kind === 'object') {
    return (
      <>
        {node.description ? <p>{node.description}</p> : null}
        {node.children.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
          />
        ))}
      </>
    );
  }
  return <RenderTree node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />;
};

const RenderTree = ({
  node,
  collapseObject = false,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback
}: {
  node: RenderNode;
  collapseObject?: boolean;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
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
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              onSubmitFeedback={onSubmitFeedback}
            />
          ))}
        </details>
      );
    }
    return (
      <section className="node">
        <FieldHeading label={node.label} description={node.description} />
        {issues}
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
        {node.children.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
          />
        ))}
      </section>
    );
  }
  if (node.kind === 'array') {
    return (
      <section className="node array-node">
        <FieldHeading label={node.label} description={node.description} meta={formatItemCount(node.items.length)} />
        {issues}
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
        {node.items.map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            collapseObject={child.kind === 'object'}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
          />
        ))}
      </section>
    );
  }
  if (node.kind === 'raw') {
    return (
      <section className="field">
        <FieldHeading label={node.label} description={node.description} />
        {issues}
        <p className="raw-reason">{node.reason}</p>
        <pre>{JSON.stringify(node.value, null, 2)}</pre>
        <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
      </section>
    );
  }
  const nodeHistory = node.path ? history?.[node.path] : undefined;
  const latestEdit = latestEditValue(nodeHistory);
  const displayedValue = latestEdit ?? formatValue(node.value);
  const isEdited = latestEdit !== undefined;
  return (
    <section className="field">
      <FieldHeading label={node.label} description={node.description} />
      {issues}
      {node.enumValues ? (
        <EnumValue node={node} value={displayedValue} edited={isEdited} />
      ) : (
        <output className={isEdited ? 'edited-value' : undefined}>{displayedValue}</output>
      )}
      <FeedbackPanel node={node} feedbackConfig={feedbackConfig} history={history} projectUser={projectUser} onSubmitFeedback={onSubmitFeedback} />
    </section>
  );
};

const FieldHeading = ({ label, description, meta }: { label: string; description?: string; meta?: string }) => (
  <h3 className="field-heading">
    <span className="field-label">{label}</span>
    {description ? <span className="field-description">{description}</span> : null}
    {meta ? <span className="field-meta">{meta}</span> : null}
  </h3>
);

const FeedbackPanel = ({
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
  const path = node.path;
  const config = path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, path) : undefined;
  const nodeHistory = path ? history?.[path] : undefined;
  const initialEditValue = editableValue(node, nodeHistory);
  const [feedbackValue, setFeedbackValue] = useState('');
  const [commentValue, setCommentValue] = useState('');
  const [editValue, setEditValue] = useState(initialEditValue);
  useEffect(() => {
    setEditValue(initialEditValue);
  }, [initialEditValue, path]);
  if (!path || !config || !onSubmitFeedback) {
    return null;
  }
  const allHistory = collectHistory(nodeHistory, editableValue(node));
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
      {showFeedbackControls && config.comments ? (
        <label className="feedback-input">
          Comment
          <textarea value={commentValue} onChange={(event) => setCommentValue(event.target.value)} rows={2} />
        </label>
      ) : null}
      {showFeedbackControls && config.editable ? (
        <label className="feedback-input">
          Edit
          <EditInput node={node} value={editValue} onChange={setEditValue} />
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

const latestEditValue = (history: FeedbackHistory | undefined): string | undefined =>
  [...(history?.edits ?? [])].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0]?.value;

const editableValue = (node: RenderNode, history?: FeedbackHistory): string =>
  latestEditValue(history) ?? (node.kind === 'value' ? formatValue(node.value) : '');

const collectHistory = (
  history: FeedbackHistory | undefined,
  originalValue = ''
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
  return history?.edits.length && originalValue ? [...sorted, { username: '', timestamp: '', original: originalValue }] : sorted;
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

const EnumValue = ({ node, value, edited }: { node: Extract<RenderNode, { kind: 'value' }>; value: string; edited: boolean }) => {
  const enumOptions = node.enumValues ?? [];
  const selectedOption = enumOptions.find((option) => formatValue(option) === value);
  const selectedValue = selectedOption === undefined ? enumOptionValue(value) : enumOptionValue(selectedOption);
  const hasSelectedOption = selectedOption !== undefined;

  return (
    <select
      aria-label={node.label}
      className={`enum-select${edited ? ' edited-value' : ''}`}
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
