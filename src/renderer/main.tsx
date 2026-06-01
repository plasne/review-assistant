import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatusSnapshot, AppBootstrap, ChatMessage, OpenProjectResult, RecordDetail, RenderNode } from '../shared/types';
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | undefined>();
  const [chatState, setChatState] = useState<ChatState>('ready');
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();
  const [newProjectId, setNewProjectId] = useState('');
  const [isCreateProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
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
    if (!projectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const result = await window.reviewAssistant.openProject(projectId);
      setProject(result);
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

  const refreshRecords = async () => {
    if (!selectedProjectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const result = await window.reviewAssistant.openProject(selectedProjectId);
      setProject(result);
      if (record && !result.records.some((item) => item.id === record.recordId)) {
        setRecord(undefined);
      }
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
        <div className="header-spacer" aria-hidden="true" />
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
          {record ? <RecordDetails record={record} /> : <p className="empty">Choose a record to inspect read-only details.</p>}
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

const RecordDetails = ({ record }: { record: RecordDetail }) => (
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
    <RenderTreeRoot node={record.renderTree} />
  </div>
);

const RenderTreeRoot = ({ node }: { node: RenderNode }) => {
  if (node.kind === 'object') {
    return (
      <>
        {node.description ? <p>{node.description}</p> : null}
        {node.children.map((child) => (
          <RenderTree key={child.label} node={child} />
        ))}
      </>
    );
  }
  return <RenderTree node={node} />;
};

const RenderTree = ({ node, collapseObject = false }: { node: RenderNode; collapseObject?: boolean }) => {
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
            <RenderTree key={child.label} node={child} />
          ))}
        </details>
      );
    }
    return (
      <section className="node">
        <FieldHeading label={node.label} description={node.description} />
        {issues}
        {node.children.map((child) => (
          <RenderTree key={child.label} node={child} />
        ))}
      </section>
    );
  }
  if (node.kind === 'array') {
    return (
      <section className="node array-node">
        <FieldHeading label={node.label} description={node.description} meta={formatItemCount(node.items.length)} />
        {issues}
        {node.items.map((child) => (
          <RenderTree key={child.label} node={child} collapseObject={child.kind === 'object'} />
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
      </section>
    );
  }
  return (
    <section className="field">
      <FieldHeading label={node.label} description={node.description} />
      {issues}
      {node.enumValues ? <EnumValue node={node} /> : <output>{formatValue(node.value)}</output>}
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
  const selectedValue = enumOptionValue(node.value);
  const enumOptions = node.enumValues ?? [];
  const hasSelectedOption = enumOptions.some((value) => enumOptionValue(value) === selectedValue);

  return (
    <select
      aria-label={node.label}
      className="enum-select"
      value={selectedValue}
      onChange={(event) => {
        event.currentTarget.value = selectedValue;
      }}
    >
      {hasSelectedOption ? null : <option value={selectedValue}>{formatValue(node.value)} (not allowed)</option>}
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
