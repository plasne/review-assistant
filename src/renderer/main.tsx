import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PatchDiff } from '@pierre/diffs/react';
import type {
  AgentStatusSnapshot,
  AppBootstrap,
  ChatAttachment,
  ChatMessage,
  ContinueWithGitHubResult,
  FeedbackConfig,
  FeedbackConfigEntry,
  FeedbackEditMode,
  FeedbackEntry,
  FeedbackHistory,
  FeedbackMode,
  FeedbackSubmissionInput,
  OpenProjectResult,
  ProjectUser,
  QueueInfo,
  RecordDetail,
  RecordSummary,
  RenderNode,
  TagFilter,
  TagDefinition,
  Theme,
  ThemeTokens,
  ThemeState,
  ValidationIssue
} from '../shared/types';
import { CANONICAL_MAPPINGS, feedbackConfigEntryForPath, FEEDBACK_EDIT_MODES, FEEDBACK_MODES, FIELD_PRESENTATIONS } from '../shared/feedback';
import { applyThemeState, readableTextColor } from './theme';
import './styles.css';

type Status = 'idle' | 'loading' | 'error';
type ChatState = 'ready' | 'streaming' | 'canceled' | 'error';
type ColumnKey = 'records' | 'details' | 'chat';
type NodeTab = {
  id: string;
  label: string;
  node: RenderNode;
};
type FeedbackDraft = {
  feedbackValue?: string;
  commentValue?: string;
  editValue?: string;
};
type FeedbackDrafts = Record<string, FeedbackDraft>;
type PendingNavigation =
  | { kind: 'project'; projectId: string }
  | { kind: 'createProject'; projectId: string }
  | { kind: 'createRecord' }
  | { kind: 'record'; recordId: string }
  | { kind: 'refreshRecords' }
  | { kind: 'close' };

type QueueTagState = 'include' | 'exclude' | 'ignore';
type ActiveQueueWork = {
  queueName: string;
  popReceipt: string;
  projectId: string;
  recordId: string;
  instructions?: string;
  bannerVisible: boolean;
};

const MIN_COLUMN_PERCENT = 16;
const NEW_RECORD_ID_BASE = 'new-record';
const MAX_CHAT_ATTACHMENTS = 5;
const MAX_TAGS_PER_RECORD = 100;
const MAX_TAG_LENGTH = 100;
const NOT_SET_LABEL = '(not set)';

const noVisibleQueueMessagesMessage = (queueName: string): string =>
  `No visible messages are available in '${queueName}'. The queue may be empty or its messages may still be invisible.`;

type ThemeDraft = {
  id: string;
  name: string;
  tokens: ThemeTokens;
};

const THEME_TOKEN_FIELDS = [
  { key: 'bg', label: 'Background' },
  { key: 'bg2', label: 'Secondary background' },
  { key: 'surface', label: 'Surface' },
  { key: 'surface2', label: 'Raised surface' },
  { key: 'border', label: 'Border' },
  { key: 'text', label: 'Text' },
  { key: 'textDim', label: 'Dim text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent2', label: 'Secondary accent' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'danger', label: 'Danger' },
  { key: 'focusRing', label: 'Focus ring' },
  { key: 'fontSans', label: 'Sans font' },
  { key: 'fontSerif', label: 'Serif font' }
] as const satisfies readonly { key: keyof ThemeTokens; label: string }[];

const REQUIRED_THEME_TOKEN_KEYS = THEME_TOKEN_FIELDS.filter((field) => field.key !== 'fontSerif').map((field) => field.key);
const COLOR_THEME_TOKEN_KEYS = new Set<keyof ThemeTokens>(
  THEME_TOKEN_FIELDS.filter((field) => field.key !== 'fontSans' && field.key !== 'fontSerif').map((field) => field.key)
);

const emptyThemeTokens = (): ThemeTokens => ({
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
  fontSans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSerif: 'Georgia, "Times New Roman", serif'
});

const slugifyThemeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const createThemeDraft = (source: Theme | undefined, themeState: ThemeState | undefined): ThemeDraft => {
  const baseTokens = source?.tokens ?? themeState?.themes.find((theme) => theme.id === themeState.activeThemeId)?.tokens ?? emptyThemeTokens();
  const baseName = source ? `${source.name} Custom` : 'Custom Theme';
  const baseId = slugifyThemeId(source ? `${source.id}-custom` : 'custom-theme');
  const existingIds = new Set(themeState?.themes.map((theme) => theme.id) ?? []);
  let id = baseId || 'custom-theme';
  for (let index = 2; existingIds.has(id); index += 1) {
    const suffix = `-${index}`;
    id = `${id.slice(0, Math.max(0, 63 - suffix.length))}${suffix}`;
  }
  return { id, name: baseName, tokens: { ...baseTokens } };
};

const nextNewRecordId = (existingIds: string[]): string => {
  const existing = new Set(existingIds);
  if (!existing.has(NEW_RECORD_ID_BASE)) {
    return NEW_RECORD_ID_BASE;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${NEW_RECORD_ID_BASE}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
};

const shuffleRecords = (records: RecordSummary[]): RecordSummary[] => {
  const shuffled = [...records];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

const normalizeRecordFilename = (value: string): { ok: true; recordId: string } | { ok: false; message: string } => {
  const trimmed = value.trim();
  const withoutExtension = trimmed.toLowerCase().endsWith('.json') ? trimmed.slice(0, -'.json'.length) : trimmed;
  if (!withoutExtension) {
    return { ok: false, message: 'Filename is required.' };
  }
  if (withoutExtension.startsWith('_')) {
    return { ok: false, message: 'Filename cannot start with an underscore.' };
  }
  if (withoutExtension.includes('/') || withoutExtension.includes('\\') || withoutExtension.includes('..')) {
    return { ok: false, message: 'Filename cannot include path separators or "..".' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(withoutExtension)) {
    return { ok: false, message: 'Filename can only use letters, numbers, dots, underscores, and hyphens.' };
  }
  return { ok: true, recordId: withoutExtension };
};

const formatBytes = (sizeBytes: number): string => {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  return `${Math.ceil(sizeBytes / 1024)} KB`;
};

const formatChatMessageWithAttachments = (content: string, attachments: ChatAttachment[]): string => {
  if (attachments.length === 0) {
    return content;
  }
  const summary = attachments.map((attachment) => `- ${attachment.name} (${formatBytes(attachment.sizeBytes)})`).join('\n');
  return `${content}\n\nAttached files:\n${summary}`;
};

const recordDraftErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const recordAlreadyExists = message.match(/Record already exists:\s*([^\s]+)/);
  if (recordAlreadyExists?.[1]) {
    return `Record already exists: ${recordAlreadyExists[1]}.json`;
  }
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
};

const App = () => {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | undefined>();
  const [themeState, setThemeState] = useState<ThemeState | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [project, setProject] = useState<OpenProjectResult | undefined>();
  const [record, setRecord] = useState<RecordDetail | undefined>();
  const [feedbackConfig, setFeedbackConfig] = useState<FeedbackConfig | undefined>();
  const [draftFeedbackConfig, setDraftFeedbackConfig] = useState<FeedbackConfig | undefined>();
  const [projectUser, setProjectUser] = useState<ProjectUser | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatAttachmentError, setChatAttachmentError] = useState<string | undefined>();
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | undefined>();
  const [loginDialog, setLoginDialog] = useState<ContinueWithGitHubResult | undefined>();
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [chatState, setChatState] = useState<ChatState>('ready');
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>();
  const [newProjectId, setNewProjectId] = useState('');
  const [newRecordFilename, setNewRecordFilename] = useState('');
  const [newRecordFilenameError, setNewRecordFilenameError] = useState<string | undefined>();
  const [isCreateProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [isCreateRecordDialogOpen, setCreateRecordDialogOpen] = useState(false);
  const [isFeedbackConfigOpen, setFeedbackConfigOpen] = useState(false);
  const [isThemeManagerOpen, setThemeManagerOpen] = useState(false);
  const [isQueueManagerOpen, setQueueManagerOpen] = useState(false);
  const [queues, setQueues] = useState<QueueInfo[]>([]);
  const [selectedQueueName, setSelectedQueueName] = useState('');
  const [queueError, setQueueError] = useState<string | undefined>();
  const [queueSuccess, setQueueSuccess] = useState<string | undefined>();
  const [newQueueName, setNewQueueName] = useState('');
  const [queueProjectId, setQueueProjectId] = useState('');
  const [queueTagNames, setQueueTagNames] = useState<string[]>([]);
  const [isQueueProjectLoading, setQueueProjectLoading] = useState(false);
  const [queueTagStates, setQueueTagStates] = useState<Record<string, QueueTagState>>({});
  const [queueSearchResults, setQueueSearchResults] = useState<RecordSummary[]>([]);
  const [sampleSize, setSampleSize] = useState(10);
  const [queueInstructions, setQueueInstructions] = useState('');
  const [isQueueLoading, setQueueLoading] = useState(false);
  const [activeQueueWork, setActiveQueueWork] = useState<ActiveQueueWork | undefined>();
  const [themeDraft, setThemeDraft] = useState<ThemeDraft | undefined>();
  const [themeError, setThemeError] = useState<string | undefined>();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [feedbackDrafts, setFeedbackDrafts] = useState<FeedbackDrafts>({});
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | undefined>();
  const [showExtraSchemaFields, setShowExtraSchemaFields] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | undefined>();
  const [saveWarning, setSaveWarning] = useState<string | undefined>();
  const [columns, setColumns] = useState({ records: 22, details: 48, chat: 30 });
  const columnsRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<OpenProjectResult | undefined>(undefined);
  const recordRef = useRef<RecordDetail | undefined>(undefined);
  const inlineEditVersionRef = useRef(0);
  const inlineEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  const inlineDraftDataRef = useRef<unknown>(undefined);
  const recordButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedProjectIdRef = useRef('');
  const selectedRecordIdRef = useRef<string | undefined>(undefined);
  const hasUnsavedChangesRef = useRef(false);
  const hasStagedChangesRef = useRef(false);
  const feedbackDraftsRef = useRef<FeedbackDrafts>({});
  const draftRecordIdsRef = useRef<Set<string>>(new Set());
  const chatStateRef = useRef<ChatState>('ready');
  const activeLoginIdRef = useRef<string | undefined>(undefined);
  const activeQueueWorkRef = useRef<ActiveQueueWork | undefined>(undefined);
  const queueProjectRequestRef = useRef(0);
  const loginDialogTitleId = useId();

  const applyThemeStateUpdate = (nextThemeState: ThemeState): void => {
    applyThemeState(nextThemeState);
    setThemeState(nextThemeState);
  };

  const openProjectConfiguration = () => {
    if (!selectedProjectId || !project) {
      return;
    }
    setDraftFeedbackConfig(feedbackConfig ?? { properties: {} });
    setFeedbackConfigOpen(true);
  };

  useEffect(() => {
    activeRequestIdRef.current = activeRequestId;
  }, [activeRequestId]);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    selectedRecordIdRef.current = record?.recordId;
    recordRef.current = record;
  }, [record?.recordId]);

  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  useEffect(() => {
    activeQueueWorkRef.current = activeQueueWork;
  }, [activeQueueWork]);

  const selectRecordDetail = (nextRecord: RecordDetail | undefined) => {
    inlineEditVersionRef.current += 1;
    inlineDraftDataRef.current = nextRecord?.data;
    setRecord(nextRecord);
  };

  useEffect(() => {
    if (!record?.recordId) {
      return;
    }
    recordButtonRefs.current.get(record.recordId)?.scrollIntoView({ block: 'nearest' });
  }, [record?.recordId]);

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
        if (result.themeState) {
          applyThemeStateUpdate(result.themeState);
        }
        setBootstrap(result);
        if (result.backendKind && result.backendKind !== 'local') {
          void refreshQueues();
        }
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
        void refreshProjectAndSelectedRecord();
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
        void refreshProjectAndSelectedRecord();
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
        void refreshProjectAndSelectedRecord();
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
      }),
      window.reviewAssistant.onCloseRequested(() => {
        void (async () => {
          if (chatStateRef.current === 'streaming' || (await refreshUnsavedStatus())) {
            setPendingNavigation({ kind: 'close' });
            return;
          }
          await window.reviewAssistant.closeWindow();
        })();
      })
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [agentStatus?.provider]);

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChangesRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, []);

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
    selectRecordDetail(undefined);
    setActiveQueueWork(undefined);
    updateUnsavedChanges(false);
    updateFeedbackDrafts({});
    draftRecordIdsRef.current = new Set();
    setFeedbackConfig(undefined);
    setDraftFeedbackConfig(undefined);
    if (!projectId) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    setSaveWarning(undefined);
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
    setSaveWarning(undefined);
    setActiveQueueWork(undefined);
    try {
      selectRecordDetail(await window.reviewAssistant.getRecord(selectedProjectId, recordId));
      updateFeedbackDrafts({});
      await refreshUnsavedStatus(selectedProjectId, recordId);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshProjectState = async () => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) {
      return undefined;
    }
    const result = await window.reviewAssistant.openProject(projectId);
    const draftRecords = (projectRef.current?.records ?? []).filter((item) => draftRecordIdsRef.current.has(item.id));
    const refreshedProject = {
      ...result,
      records: [...result.records, ...draftRecords.filter((draftRecord) => !result.records.some((item) => item.id === draftRecord.id))].sort((left, right) =>
        left.displayName.localeCompare(right.displayName)
      )
    };
    setProject(refreshedProject);
    setFeedbackConfig(result.feedbackConfig);
    setDraftFeedbackConfig(result.feedbackConfig);
    const currentRecordId = selectedRecordIdRef.current;
    if (currentRecordId && !refreshedProject.records.some((item) => item.id === currentRecordId)) {
      selectRecordDetail(undefined);
    }
    return refreshedProject;
  };

  const refreshProjectAndSelectedRecord = async () => {
    const projectId = selectedProjectIdRef.current;
    const recordId = selectedRecordIdRef.current;
    if (!projectId) {
      return;
    }
    try {
      const result = await refreshProjectState();
      if (recordId && result?.records.some((item) => item.id === recordId)) {
        selectRecordDetail(await window.reviewAssistant.getRecord(projectId, recordId));
        await refreshUnsavedStatus(projectId, recordId);
      } else {
        updateUnsavedChanges(false);
      }
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshSelectedRecord = async () => {
    const projectId = selectedProjectIdRef.current;
    const recordId = selectedRecordIdRef.current;
    if (!projectId || !recordId) {
      return;
    }
    try {
      selectRecordDetail(await window.reviewAssistant.getRecord(projectId, recordId));
      await refreshUnsavedStatus(projectId, recordId);
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const refreshUnsavedStatus = async (projectId = selectedProjectIdRef.current, recordId = selectedRecordIdRef.current) => {
    if (!projectId || !recordId) {
      updateUnsavedChanges(false);
      return false;
    }
    const draftStatus = await window.reviewAssistant.getRecordDraftStatus(projectId, recordId);
    updateUnsavedChanges(draftStatus.hasUnsavedChanges);
    return draftStatus.hasUnsavedChanges || hasPendingFeedbackDrafts(feedbackDraftsRef.current);
  };

  const updateUnsavedChanges = (value: boolean) => {
    hasStagedChangesRef.current = value;
    const combinedValue = value || hasPendingFeedbackDrafts(feedbackDraftsRef.current);
    hasUnsavedChangesRef.current = combinedValue;
    setHasUnsavedChanges(combinedValue);
  };

  const updateFeedbackDrafts = (drafts: FeedbackDrafts) => {
    feedbackDraftsRef.current = drafts;
    setFeedbackDrafts(drafts);
    const combinedValue = hasStagedChangesRef.current || hasPendingFeedbackDrafts(drafts);
    hasUnsavedChangesRef.current = combinedValue;
    setHasUnsavedChanges(combinedValue);
  };

  const changeFeedbackDraft = (path: string, draft: FeedbackDraft) => {
    updateFeedbackDrafts(removeEmptyFeedbackDrafts({ ...feedbackDraftsRef.current, [path]: draft }));
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
        selectRecordDetail(undefined);
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
      await refreshSelectedRecord();
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
      selectRecordDetail(result.record);
      inlineDraftDataRef.current = result.record.data;
      updateUnsavedChanges(true);
      await refreshProjectUser(selectedProjectId);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const updateInlineRecordValue = async (node: Extract<RenderNode, { kind: 'array' | 'value' | 'raw' }>, value: string) => {
    const currentRecord = recordRef.current;
    const projectId = selectedProjectIdRef.current;
    if (!projectId || !currentRecord || !node.path) {
      return;
    }
    const nextData = writeJsonPointer(inlineDraftDataRef.current ?? currentRecord.data, node.path, coerceInlineEditValue(node, value));
    inlineDraftDataRef.current = nextData;
    const version = ++inlineEditVersionRef.current;
    const updateRequest = inlineEditQueueRef.current.then(() => window.reviewAssistant.updateRecordData(projectId, currentRecord.recordId, nextData));
    inlineEditQueueRef.current = updateRequest.then(
      () => undefined,
      () => undefined
    );
    try {
      const updated = await updateRequest;
      if (version !== inlineEditVersionRef.current || selectedRecordIdRef.current !== currentRecord.recordId) {
        return;
      }
      inlineDraftDataRef.current = updated.data;
      setRecord(updated);
      updateUnsavedChanges(true);
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const submitPendingFeedbackDrafts = async () => {
    if (!selectedProjectId || !record) {
      return;
    }
    const drafts = Object.entries(feedbackDraftsRef.current);
    for (const [propertyPath, draft] of drafts) {
      const result = await window.reviewAssistant.submitFeedback(selectedProjectId, record.recordId, {
        propertyPath,
        feedbackValue: draft.feedbackValue,
        commentValue: draft.commentValue,
        editValue: draft.editValue
      });
      selectRecordDetail(result.record);
      updateUnsavedChanges(true);
    }
    if (drafts.length > 0) {
      updateFeedbackDrafts({});
      await refreshProjectUser(selectedProjectId);
    }
  };

  const computeSelectedRecordTags = async () => {
    if (!selectedProjectId || !record) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      await inlineEditQueueRef.current;
      await submitPendingFeedbackDrafts();
      const result = await window.reviewAssistant.computeRecordTags(selectedProjectId, record.recordId);
      selectRecordDetail(result.record);
      inlineDraftDataRef.current = result.record.data;
      setSaveWarning(result.tagPluginWarning);
      updateUnsavedChanges(true);
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaveWarning(undefined);
    }
  };

  const saveSelectedRecordChanges = async (): Promise<boolean> => {
    if (!selectedProjectId || !record) {
      return false;
    }
    setStatus('loading');
    setError(undefined);
    try {
      await submitPendingFeedbackDrafts();
      const queueWork = activeQueueWorkRef.current;
      const result =
        queueWork && queueWork.projectId === selectedProjectId && queueWork.recordId === record.recordId
          ? await window.reviewAssistant.saveRecordChanges(selectedProjectId, record.recordId, {
              queue: { queueName: queueWork.queueName, popReceipt: queueWork.popReceipt }
            })
          : await window.reviewAssistant.saveRecordChanges(selectedProjectId, record.recordId);
      selectRecordDetail(result.record);
      setSaveWarning(result.tagPluginWarning);
      draftRecordIdsRef.current.delete(record.recordId);
      if (queueWork?.projectId === selectedProjectId && queueWork.recordId === record.recordId) {
        setActiveQueueWork(undefined);
        void refreshQueues();
      }
      updateFeedbackDrafts({});
      updateUnsavedChanges(false);
      await refreshProjectUser(selectedProjectId);
      setStatus('idle');
      return true;
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaveWarning(undefined);
      return false;
    }
  };

  const isAzureBackend = bootstrap?.backendKind === 'azure-connection-string' || bootstrap?.backendKind === 'azure-default-credential';

  const refreshQueues = async () => {
    setQueueError(undefined);
    try {
      const result = await window.reviewAssistant.queue.listQueues();
      setQueues(result);
      setSelectedQueueName((current) => (current && result.some((queue) => queue.name === current) ? current : (result[0]?.name ?? '')));
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const createQueue = async (event: React.FormEvent) => {
    event.preventDefault();
    setQueueError(undefined);
    setQueueSuccess(undefined);
    const queueName = newQueueName.trim();
    if (!/^[a-z0-9-]{1,63}$/.test(queueName)) {
      setQueueError('Queue name must contain only lowercase letters, numbers, and hyphens (1-63 chars)');
      return;
    }
    setQueueLoading(true);
    try {
      const created = await window.reviewAssistant.queue.createQueue(queueName);
      setQueues((current) => [...current.filter((queue) => queue.name !== created.name), created].sort((left, right) => left.name.localeCompare(right.name)));
      setSelectedQueueName(created.name);
      setNewQueueName('');
      setQueueSuccess(`Created queue '${created.name}'.`);
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQueueLoading(false);
    }
  };

  const clearQueue = async () => {
    if (!selectedQueueName || !window.confirm(`Clear all messages from '${selectedQueueName}'?`)) {
      return;
    }
    setQueueLoading(true);
    setQueueError(undefined);
    try {
      await window.reviewAssistant.queue.clearQueue(selectedQueueName);
      await refreshQueues();
      setQueueSuccess(`Cleared queue '${selectedQueueName}'.`);
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQueueLoading(false);
    }
  };

  const deleteQueue = async () => {
    if (!selectedQueueName || !window.confirm(`Delete queue '${selectedQueueName}'?`)) {
      return;
    }
    setQueueLoading(true);
    setQueueError(undefined);
    try {
      await window.reviewAssistant.queue.deleteQueue(selectedQueueName);
      await refreshQueues();
      setQueueSuccess(`Deleted queue '${selectedQueueName}'.`);
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQueueLoading(false);
    }
  };

  const queueTagFilter = (): TagFilter => ({
    included: Object.entries(queueTagStates)
      .filter(([, state]) => state === 'include')
      .map(([tag]) => tag),
    excluded: Object.entries(queueTagStates)
      .filter(([, state]) => state === 'exclude')
      .map(([tag]) => tag)
  });

  const cycleQueueTagState = (tagName: string) => {
    setQueueTagStates((current) => {
      const currentState = current[tagName] ?? 'ignore';
      const nextState: QueueTagState = currentState === 'ignore' ? 'include' : currentState === 'include' ? 'exclude' : 'ignore';
      return { ...current, [tagName]: nextState };
    });
  };

  const selectQueueProject = async (projectId: string) => {
    const requestId = ++queueProjectRequestRef.current;
    setQueueProjectId(projectId);
    setQueueTagNames([]);
    setQueueProjectLoading(false);
    setQueueTagStates({});
    setQueueSearchResults([]);
    setQueueError(undefined);
    setQueueSuccess(undefined);
    if (!projectId) {
      return;
    }
    setQueueProjectLoading(true);
    try {
      const tags = await window.reviewAssistant.listProjectTags(projectId);
      if (queueProjectRequestRef.current === requestId) {
        setQueueTagNames(tags);
      }
    } catch (caught) {
      if (queueProjectRequestRef.current === requestId) {
        setQueueError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (queueProjectRequestRef.current === requestId) {
        setQueueProjectLoading(false);
      }
    }
  };

  const searchQueueRecords = async () => {
    if (!queueProjectId) {
      setQueueError('Select a project before searching.');
      return;
    }
    setQueueLoading(true);
    setQueueError(undefined);
    setQueueSuccess(undefined);
    setQueueSearchResults([]);
    try {
      setQueueSearchResults(await window.reviewAssistant.queue.searchRecords(queueProjectId, queueTagFilter()));
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQueueLoading(false);
    }
  };

  const enqueueRecords = async (mode: 'all' | 'sample') => {
    if (!selectedQueueName || !queueProjectId) {
      setQueueError('Select a queue and project before adding work.');
      return;
    }
    const selected = mode === 'sample' ? shuffleRecords(queueSearchResults).slice(0, Math.max(0, sampleSize)) : queueSearchResults;
    setQueueLoading(true);
    setQueueError(undefined);
    setQueueSuccess(undefined);
    try {
      for (const item of selected) {
        await window.reviewAssistant.queue.enqueueMessage(selectedQueueName, {
          project: queueProjectId,
          filename: item.id,
          ...(queueInstructions ? { instructions: queueInstructions } : {})
        });
      }
      await refreshQueues();
      setQueueSuccess(`Added ${selected.length} record${selected.length === 1 ? '' : 's'} to '${selectedQueueName}'.`);
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQueueLoading(false);
    }
  };

  const openQueueManager = () => {
    setQueueError(undefined);
    setQueueSuccess(undefined);
    setQueueProjectId('');
    setQueueTagNames([]);
    setQueueProjectLoading(false);
    setQueueTagStates({});
    setQueueSearchResults([]);
    setQueueManagerOpen(true);
    void refreshQueues();
  };

  const getRecordFromQueue = async () => {
    if (!selectedQueueName) {
      setQueueError('No queues available. Create a queue to get started.');
      return;
    }
    if (chatState === 'streaming' || (await refreshUnsavedStatus())) {
      setStatus('error');
      setError('Save or discard current changes before getting a record from a queue.');
      return;
    }
    setStatus('loading');
    setError(undefined);
    setQueueError(undefined);
    try {
      const dequeued = await window.reviewAssistant.queue.dequeueMessage(selectedQueueName);
      if (!dequeued) {
        const message = noVisibleQueueMessagesMessage(selectedQueueName);
        setStatus('error');
        setError(message);
        setQueueError(message);
        return;
      }
      setSelectedProjectId(dequeued.message.project);
      setProject(undefined);
      selectRecordDetail(undefined);
      updateUnsavedChanges(false);
      updateFeedbackDrafts({});
      draftRecordIdsRef.current = new Set();
      const opened = await window.reviewAssistant.openProject(dequeued.message.project);
      setProject(opened);
      setFeedbackConfig(opened.feedbackConfig);
      setDraftFeedbackConfig(opened.feedbackConfig);
      await refreshProjectUser(dequeued.message.project);
      const loadedRecord = await window.reviewAssistant.getRecord(dequeued.message.project, dequeued.message.filename);
      selectRecordDetail(loadedRecord);
      const queueInstructions = dequeued.message.instructions?.trim();
      setActiveQueueWork({
        queueName: selectedQueueName,
        popReceipt: dequeued.popReceipt,
        projectId: dequeued.message.project,
        recordId: dequeued.message.filename,
        instructions: queueInstructions,
        bannerVisible: Boolean(queueInstructions)
      });
      await refreshUnsavedStatus(dequeued.message.project, dequeued.message.filename);
      await refreshQueues();
      setStatus('idle');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const discardSelectedRecordChanges = async () => {
    if (!selectedProjectId || !record) {
      updateUnsavedChanges(false);
      return;
    }
    const discardedRecordId = record.recordId;
    await window.reviewAssistant.discardRecordChanges(selectedProjectId, discardedRecordId);
    if (draftRecordIdsRef.current.has(discardedRecordId)) {
      setProject((current) =>
        current
          ? {
              ...current,
              records: current.records.filter((item) => item.id !== discardedRecordId)
            }
          : current
      );
    }
    updateFeedbackDrafts({});
    updateUnsavedChanges(false);
  };

  const createNewRecordDraft = async (recordId: string) => {
    if (!selectedProjectId || !project) {
      return;
    }
    setStatus('loading');
    setError(undefined);
    try {
      const created = await window.reviewAssistant.createRecordDraft(selectedProjectId, recordId);
      draftRecordIdsRef.current.add(created.recordId);
      selectRecordDetail(created);
      setProject((current) =>
        current
          ? {
              ...current,
              records: [...current.records.filter((item) => item.id !== created.recordId), { id: created.recordId, displayName: created.displayName }].sort((a, b) =>
                a.displayName.localeCompare(b.displayName)
              )
            }
          : current
      );
      updateFeedbackDrafts({});
      updateUnsavedChanges(true);
      setNewRecordFilename('');
      setNewRecordFilenameError(undefined);
      setCreateRecordDialogOpen(false);
      setStatus('idle');
    } catch (caught) {
      setStatus('idle');
      setNewRecordFilenameError(recordDraftErrorMessage(caught));
    }
  };

  const openCreateRecordDialog = () => {
    if (!project) {
      return;
    }
    setNewRecordFilename('');
    setNewRecordFilenameError(undefined);
    setCreateRecordDialogOpen(true);
  };

  const requestCreateRecord = async () => {
    if (!selectedProjectId || !project) {
      return;
    }
    if (chatState === 'streaming') {
      setPendingNavigation({ kind: 'createRecord' });
      return;
    }
    if (await refreshUnsavedStatus()) {
      setPendingNavigation({ kind: 'createRecord' });
      return;
    }
    openCreateRecordDialog();
  };

  const createRecord = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRecordFilename(newRecordFilename);
    if (!normalized.ok) {
      setNewRecordFilenameError(normalized.message);
      return;
    }
    if (project?.records.some((item) => item.id === normalized.recordId && !draftRecordIdsRef.current.has(item.id))) {
      setNewRecordFilenameError(`Record already exists: ${normalized.recordId}.json`);
      return;
    }
    await createNewRecordDraft(normalized.recordId);
  };

  const requestProjectOpen = async (projectId: string) => {
    if (projectId === selectedProjectId) {
      return;
    }
    if (chatState === 'streaming') {
      setPendingNavigation({ kind: 'project', projectId });
      return;
    }
    if (await refreshUnsavedStatus()) {
      setPendingNavigation({ kind: 'project', projectId });
      return;
    }
    await openProject(projectId);
  };

  const requestRecordOpen = async (recordId: string) => {
    if (recordId === selectedRecordId) {
      return;
    }
    if (chatState === 'streaming') {
      setPendingNavigation({ kind: 'record', recordId });
      return;
    }
    if (await refreshUnsavedStatus()) {
      setPendingNavigation({ kind: 'record', recordId });
      return;
    }
    await openRecord(recordId);
  };

  const requestRefreshRecords = async () => {
    if (chatState === 'streaming') {
      setPendingNavigation({ kind: 'refreshRecords' });
      return;
    }
    if (await refreshUnsavedStatus()) {
      setPendingNavigation({ kind: 'refreshRecords' });
      return;
    }
    await refreshRecords();
  };

  const cancelPendingNavigation = () => setPendingNavigation(undefined);

  const discardAndContinue = async () => {
    if (chatStateRef.current === 'streaming') {
      return;
    }
    const pending = pendingNavigation;
    setPendingNavigation(undefined);
    await discardSelectedRecordChanges();
    if (!pending) {
      return;
    }
    if (pending.kind === 'project') {
      await openProject(pending.projectId);
      return;
    }
    if (pending.kind === 'createProject') {
      await createAndOpenProject(pending.projectId);
      return;
    }
    if (pending.kind === 'createRecord') {
      openCreateRecordDialog();
      return;
    }
    if (pending.kind === 'record') {
      await openRecord(pending.recordId);
      return;
    }
    if (pending.kind === 'refreshRecords') {
      await refreshRecords();
      return;
    }
    await window.reviewAssistant.closeWindow();
  };

  const saveAndContinue = async () => {
    if (chatStateRef.current === 'streaming') {
      return;
    }
    const pending = pendingNavigation;
    const saved = await saveSelectedRecordChanges();
    if (!saved) {
      return;
    }
    setPendingNavigation(undefined);
    if (!pending) {
      return;
    }
    if (pending.kind === 'project') {
      await openProject(pending.projectId);
      return;
    }
    if (pending.kind === 'createProject') {
      await createAndOpenProject(pending.projectId);
      return;
    }
    if (pending.kind === 'createRecord') {
      openCreateRecordDialog();
      return;
    }
    if (pending.kind === 'record') {
      await openRecord(pending.recordId);
      return;
    }
    if (pending.kind === 'refreshRecords') {
      await refreshRecords();
      return;
    }
    await window.reviewAssistant.closeWindow();
  };

  const createAndOpenProject = async (projectId: string) => {
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

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const projectId = newProjectId.trim();
    if (!projectId) {
      return;
    }
    if (chatState === 'streaming') {
      setCreateProjectDialogOpen(false);
      setPendingNavigation({ kind: 'createProject', projectId });
      return;
    }
    if (await refreshUnsavedStatus()) {
      setCreateProjectDialogOpen(false);
      setPendingNavigation({ kind: 'createProject', projectId });
      return;
    }
    await createAndOpenProject(projectId);
  };

  const sendChat = async (event: React.FormEvent) => {
    event.preventDefault();
    await submitChat();
  };

  const submitChat = async () => {
    const attachments = chatAttachments;
    const content = chatInput.trim() || (attachments.length > 0 ? 'Please review the attached file(s).' : '');
    if (!content || chatState === 'streaming' || agentStatus?.availability === 'unavailable' || status === 'loading') {
      return;
    }
    const chatHistory = messages.filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim() !== '');
    const displayedContent = formatChatMessageWithAttachments(content, attachments);
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayedContent,
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
    setChatAttachments([]);
    setChatAttachmentError(undefined);
    setChatState('streaming');
    try {
      const chatProjectId = record?.projectId ?? (selectedProjectId || undefined);
      const chatRecordId = record?.recordId;
      const response = await window.reviewAssistant.startChat(chatProjectId, chatRecordId, content, chatHistory, attachments);
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

  const selectChatAttachments = async () => {
    if (chatState === 'streaming') {
      return;
    }
    try {
      const result = await window.reviewAssistant.selectChatAttachments();
      if (result.attachments.length === 0) {
        return;
      }
      setChatAttachmentError(undefined);
      setChatAttachments((current) => {
        const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
        for (const attachment of result.attachments) {
          byPath.set(attachment.path, attachment);
        }
        const next = [...byPath.values()];
        if (next.length > MAX_CHAT_ATTACHMENTS) {
          setChatAttachmentError(`Attach at most ${MAX_CHAT_ATTACHMENTS} files.`);
          return current;
        }
        return next;
      });
    } catch (caught) {
      setChatAttachmentError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const removeChatAttachment = (attachmentId: string) => {
    setChatAttachmentError(undefined);
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    void window.reviewAssistant.discardChatAttachment(attachmentId);
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
  const title = useMemo(() => (project ? 'records' : 'Select a project'), [project]);
  const activeTheme = themeState?.themes.find((theme) => theme.id === themeState.activeThemeId);
  const agentUnavailable = agentStatus?.availability === 'unavailable';
  const agentAuthRequired = agentUnavailable && agentStatus?.error?.code === 'AUTH_REQUIRED';
  const canSendChat = Boolean((chatInput.trim() || chatAttachments.length > 0) && chatState !== 'streaming' && !agentUnavailable && status !== 'loading');
  const agentErrorText = agentStatus?.error?.remediation ? `${agentStatus.error.message} ${agentStatus.error.remediation}` : agentStatus?.error?.message;
  const selectedQueueTagCount = Object.values(queueTagStates).filter((state) => state === 'include' || state === 'exclude').length;
  const pendingAssistantMessageId =
    chatState === 'streaming' ? [...messages].reverse().find((message) => message.role === 'assistant')?.id : undefined;
  const pendingNavigationBlockedByChat = Boolean(pendingNavigation && chatState === 'streaming');

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

  const refreshThemeState = async (): Promise<ThemeState> => {
    const nextThemeState = await window.reviewAssistant.getThemeState();
    applyThemeStateUpdate(nextThemeState);
    return nextThemeState;
  };

  const openThemeManager = () => {
    setThemeError(undefined);
    setThemeDraft(undefined);
    setThemeManagerOpen(true);
    if (!themeState) {
      void refreshThemeState().catch((caught: Error) => setThemeError(caught.message));
    }
  };

  const selectTheme = async (themeId: string) => {
    setThemeError(undefined);
    try {
      applyThemeStateUpdate(await window.reviewAssistant.setActiveTheme(themeId));
    } catch (caught) {
      setThemeError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const deleteTheme = async (themeId: string) => {
    setThemeError(undefined);
    try {
      const nextThemeState = await window.reviewAssistant.deleteTheme(themeId);
      applyThemeStateUpdate(nextThemeState);
      if (themeDraft?.id === themeId) {
        setThemeDraft(undefined);
      }
    } catch (caught) {
      setThemeError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveThemeDraft = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!themeDraft) {
      return;
    }
    setThemeError(undefined);
    const id = slugifyThemeId(themeDraft.id);
    const name = themeDraft.name.trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(id)) {
      setThemeError('Theme identifier must be 3-63 characters using lowercase letters, numbers, and hyphens.');
      return;
    }
    if (!name) {
      setThemeError('Theme name is required.');
      return;
    }
    for (const key of REQUIRED_THEME_TOKEN_KEYS) {
      if (!themeDraft.tokens[key]?.trim()) {
        setThemeError(`${THEME_TOKEN_FIELDS.find((field) => field.key === key)?.label ?? key} is required.`);
        return;
      }
    }

    try {
      const savedState = await window.reviewAssistant.saveTheme({
        id,
        name,
        builtIn: false,
        tokens: {
          ...themeDraft.tokens,
          ...(themeDraft.tokens.fontSerif?.trim() ? { fontSerif: themeDraft.tokens.fontSerif.trim() } : { fontSerif: undefined })
        }
      });
      applyThemeStateUpdate(savedState);
      applyThemeStateUpdate(await window.reviewAssistant.setActiveTheme(id));
      setThemeDraft(undefined);
    } catch (caught) {
      setThemeError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <label className="project-picker">
          <span>Project</span>
          <select
            aria-label="Current project"
            value={selectedProjectId}
            onChange={(event) => void requestProjectOpen(event.target.value)}
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
          className="create-project-button header-action-button action-icon-button"
          aria-label="Create project"
          data-tooltip="Create project"
          disabled={Boolean(bootstrap?.configError)}
          onClick={() => setCreateProjectDialogOpen(true)}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className="secondary-button header-action-button action-icon-button"
          aria-label="Configure"
          data-tooltip="Configure project"
          disabled={!selectedProjectId || !project}
          onClick={openProjectConfiguration}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        <span className="header-separator" aria-hidden="true">
          |
        </span>
        {isAzureBackend && queues.length > 0 ? (
          <div className="queue-consumer" aria-label="Queue consumer">
            <label>
              <span className="queue-consumer-label">Queue</span>
              <select value={selectedQueueName} onChange={(event) => setSelectedQueueName(event.target.value)}>
                {queues.map((queue) => (
                  <option key={queue.name} value={queue.name}>
                    {queue.name} ({queue.messageCount})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="create-project-button header-action-button action-icon-button queue-get-button"
              aria-label="Get Record"
              data-tooltip="Get from queue"
              disabled={!selectedQueueName || status === 'loading'}
              onClick={() => void getRecordFromQueue()}
            >
              <QueueGetIcon />
            </button>
          </div>
        ) : null}
        {isAzureBackend ? (
          <button
            type="button"
            className="secondary-button header-action-button action-icon-button"
            aria-label="Refresh queues"
            data-tooltip="Refresh queues"
            disabled={status === 'loading'}
            onClick={() => void refreshQueues()}
          >
            <span aria-hidden="true">↻</span>
          </button>
        ) : null}
        {isAzureBackend ? (
          <button
            type="button"
            className="secondary-button header-action-button action-icon-button"
            aria-label="Queues"
            data-tooltip="Manage queues"
            onClick={openQueueManager}
          >
            <span aria-hidden="true">☷</span>
          </button>
        ) : null}
        {isAzureBackend ? (
          <span className="header-separator" aria-hidden="true">
            |
          </span>
        ) : null}
        <button
          type="button"
          className="secondary-button header-action-button action-icon-button"
          aria-label="Manage themes"
          data-tooltip="Manage themes"
          onClick={openThemeManager}
        >
          <ThemeIcon />
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

      {isQueueManagerOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal queue-manager-modal" role="dialog" aria-modal="true" aria-labelledby="queue-manager-title">
            <div className="queue-manager-header">
              <div>
                <h2 id="queue-manager-title">Queue Manager</h2>
                <p className="modal-help">Create Azure queues, add filtered records, and refresh queue counts.</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => setQueueManagerOpen(false)}>
                Close
              </button>
            </div>
            {queueError ? (
              <p className="form-error" role="alert">
                {queueError}
              </p>
            ) : null}
            {queueSuccess ? (
              <p className="queue-success" role="status">
                {queueSuccess}
              </p>
            ) : null}

            <section className="queue-manager-section queue-manager-section-compact" aria-labelledby="queue-controls-heading">
              <div className="queue-section-heading">
                <h3 id="queue-controls-heading">Queues</h3>
              </div>
              <form className="queue-controls-form" onSubmit={(event) => void createQueue(event)}>
                <div className="queue-list">
                  {queues.length > 0 ? (
                    <label>
                      <span>Selected queue</span>
                      <select value={selectedQueueName} onChange={(event) => setSelectedQueueName(event.target.value)}>
                        {queues.map((queue) => (
                          <option key={queue.name} value={queue.name}>
                            {queue.name} ({queue.messageCount} messages)
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="empty">No queues created yet. Create one to get started.</p>
                  )}
                  <div className="queue-actions">
                    <button
                      type="button"
                      className="secondary-button action-icon-button"
                      aria-label="Refresh queues"
                      data-tooltip="Refresh queues"
                      disabled={isQueueLoading}
                      onClick={() => void refreshQueues()}
                    >
                      <span aria-hidden="true">↻</span>
                    </button>
                    <button
                      type="button"
                      className="secondary-button action-icon-button"
                      aria-label="Clear queue"
                      data-tooltip="Clear queue"
                      disabled={!selectedQueueName || isQueueLoading}
                      onClick={() => void clearQueue()}
                    >
                      <span aria-hidden="true" className="clear-icon-text">CLR</span>
                    </button>
                    <button
                      type="button"
                      className="secondary-button danger-button action-icon-button queue-delete-button"
                      aria-label="Delete queue"
                      data-tooltip="Delete queue"
                      disabled={!selectedQueueName || isQueueLoading}
                      onClick={() => void deleteQueue()}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                </div>
                <label>
                  <span>New queue</span>
                  <input
                    value={newQueueName}
                    onChange={(event) => setNewQueueName(event.target.value)}
                    placeholder="legal-review-2026-q2"
                    pattern="[a-z0-9-]{1,63}"
                    title="Use lowercase letters, numbers, and hyphens."
                  />
                </label>
                <button
                  type="submit"
                  className="create-project-button action-icon-button"
                  aria-label="Create queue"
                  data-tooltip="Create queue"
                  disabled={!newQueueName.trim() || isQueueLoading}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </form>
            </section>

            <section className="queue-manager-section" aria-labelledby="add-work-heading">
              <h3 id="add-work-heading">Add Records For Review</h3>
              <div className="queue-add-work">
                <label>
                  <span>Project</span>
                  <select value={queueProjectId} onChange={(event) => void selectQueueProject(event.target.value)}>
                    <option value="">Choose a project</option>
                    {(bootstrap?.projects ?? []).map((projectOption) => (
                      <option key={projectOption.id} value={projectOption.id}>
                        {projectOption.name}
                      </option>
                    ))}
                  </select>
                </label>
                {isQueueProjectLoading ? (
                  <p className="modal-help" aria-live="polite">Loading tags...</p>
                ) : queueTagNames.length > 0 ? (
                  <div className="queue-tag-filter" aria-label="Tag filters">
                    <span className="queue-tag-filter-count">
                      tags ({selectedQueueTagCount}/{queueTagNames.length})
                    </span>
                    {queueTagNames.map((tagName) => (
                      <button
                        key={tagName}
                        type="button"
                        className="queue-tag-filter-option"
                        data-state={queueTagStates[tagName] ?? 'ignore'}
                        aria-label={`${tagName} tag filter ${queueTagStates[tagName] ?? 'ignore'}`}
                        onClick={() => cycleQueueTagState(tagName)}
                      >
                        <span className="queue-tag-filter-box" aria-hidden="true">
                          {queueTagStates[tagName] === 'include' ? '✓' : queueTagStates[tagName] === 'exclude' ? '×' : ''}
                        </span>
                        <span className="queue-tag-filter-name">{tagName}</span>
                      </button>
                    ))}
                    <button type="button" className="secondary-button queue-tag-filter-apply" disabled={!queueProjectId || isQueueLoading || isQueueProjectLoading} onClick={() => void searchQueueRecords()}>
                      Search
                    </button>
                  </div>
                ) : queueProjectId ? (
                  <p className="modal-help">No tags configured for this project. Searches without filters return all records.</p>
                ) : (
                  <p className="modal-help">Select a project to load tag filters. Searches without filters return all records.</p>
                )}
                <section className="queue-search-results" aria-label="Records found">
                  <h4>{isQueueLoading ? 'Searching records...' : `${queueSearchResults.length} matching record${queueSearchResults.length === 1 ? '' : 's'}`}</h4>
                  {isQueueLoading ? null : queueSearchResults.length > 0 ? (
                    <p className="queue-search-result-names">{queueSearchResults.map((item) => item.displayName).join(', ')}</p>
                  ) : (
                    <p className="modal-help">No records selected for review yet.</p>
                  )}
                </section>
                <label>
                  <span>Instructions</span>
                  <textarea value={queueInstructions} onChange={(event) => setQueueInstructions(event.target.value)} rows={3} maxLength={1000} />
                </label>
                <div className="queue-sample-actions" aria-label="Add records to queue">
                  <span>Add</span>
                  <button type="button" className="create-project-button" disabled={!selectedQueueName || queueSearchResults.length === 0 || isQueueLoading} onClick={() => void enqueueRecords('all')}>
                    all
                  </button>
                  <span>or</span>
                  <input
                    aria-label="Sample count"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={String(sampleSize)}
                    onChange={(event) => setSampleSize(Number(event.target.value.replace(/\D/g, '') || '0'))}
                  />
                  <button type="button" className="secondary-button" disabled={!selectedQueueName || queueSearchResults.length === 0 || isQueueLoading} onClick={() => void enqueueRecords('sample')}>
                    samples
                  </button>
                </div>
              </div>
            </section>
          </section>
        </div>
      ) : null}

      {isThemeManagerOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal theme-manager-modal" role="dialog" aria-modal="true" aria-labelledby="theme-manager-title">
            <div className="theme-manager-header">
              <div>
                <h2 id="theme-manager-title">Themes</h2>
                <p className="modal-help">Choose a built-in theme or author a custom token set. Changes apply immediately after selection or save.</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setThemeManagerOpen(false);
                  setThemeDraft(undefined);
                  setThemeError(undefined);
                }}
              >
                Close
              </button>
            </div>

            {themeError ? (
              <p className="form-error" role="alert">
                {themeError}
              </p>
            ) : null}

            {themeState ? (
              <>
                <label className="theme-select">
                  <span>Active theme</span>
                  <select aria-label="Active theme" value={themeState.activeThemeId} onChange={(event) => void selectTheme(event.target.value)}>
                    {themeState.themes.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.name} {theme.builtIn ? '(built-in)' : '(custom)'}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="theme-list" aria-label="Available themes">
                  {themeState.themes.map((theme) => (
                    <article key={theme.id} className={theme.id === themeState.activeThemeId ? 'theme-card active' : 'theme-card'}>
                      <div className="theme-card-swatches" aria-hidden="true">
                        <span style={{ background: theme.tokens.bg }} />
                        <span style={{ background: theme.tokens.surface }} />
                        <span style={{ background: theme.tokens.accent }} />
                        <span style={{ background: theme.tokens.success }} />
                        <span style={{ background: theme.tokens.danger }} />
                      </div>
                      <div className="theme-card-body">
                        <h3>{theme.name}</h3>
                        <p>
                          {theme.builtIn ? 'Built-in' : 'Custom'} · {theme.id}
                        </p>
                      </div>
                      <div className="theme-card-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={theme.id === themeState.activeThemeId}
                          onClick={() => void selectTheme(theme.id)}
                        >
                          Select
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            setThemeDraft(theme.builtIn ? createThemeDraft(theme, themeState) : { id: theme.id, name: theme.name, tokens: { ...theme.tokens } })
                          }
                        >
                          {theme.builtIn ? 'Copy' : 'Edit'}
                        </button>
                        {!theme.builtIn ? (
                          <button type="button" className="secondary-button danger-button" onClick={() => void deleteTheme(theme.id)}>
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>

                <div className="theme-editor-shell">
                  <div className="theme-editor-heading">
                    <h3>{themeDraft ? 'Custom theme editor' : 'Create a custom theme'}</h3>
                    <button type="button" className="create-project-button" onClick={() => setThemeDraft(createThemeDraft(activeTheme, themeState))}>
                      New custom theme
                    </button>
                  </div>

                  {themeDraft ? (
                    <form className="theme-editor" onSubmit={(event) => void saveThemeDraft(event)}>
                      <div className="theme-editor-meta">
                        <label>
                          <span>Name</span>
                          <input
                            value={themeDraft.name}
                            onChange={(event) => setThemeDraft((current) => (current ? { ...current, name: event.target.value } : current))}
                          />
                        </label>
                        <label>
                          <span>Identifier</span>
                          <input
                            value={themeDraft.id}
                            onChange={(event) => setThemeDraft((current) => (current ? { ...current, id: event.target.value } : current))}
                            pattern="[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])"
                            title="Use 3-63 lowercase letters, numbers, and hyphens."
                          />
                        </label>
                      </div>

                      <div className="theme-token-grid">
                        {THEME_TOKEN_FIELDS.map((field) => (
                          <label key={field.key}>
                            <span>{field.label}</span>
                            <input
                              type={COLOR_THEME_TOKEN_KEYS.has(field.key) ? 'text' : 'text'}
                              value={themeDraft.tokens[field.key] ?? ''}
                              placeholder={field.key === 'fontSerif' ? 'Optional serif font stack' : undefined}
                              onChange={(event) =>
                                setThemeDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        tokens: {
                                          ...current.tokens,
                                          [field.key]: event.target.value
                                        }
                                      }
                                    : current
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>

                      <div className="theme-preview" aria-label="Theme preview">
                        <div style={{ background: themeDraft.tokens.bg, color: themeDraft.tokens.text, borderColor: themeDraft.tokens.border }}>
                          <strong>Preview</strong>
                          <span style={{ color: themeDraft.tokens.textDim }}>Surface and status tokens</span>
                          <button type="button" style={{ background: themeDraft.tokens.accent, color: readableTextColor(themeDraft.tokens.accent, themeDraft.tokens) }}>
                            Accent action
                          </button>
                        </div>
                      </div>

                      <div className="modal-actions">
                        <button type="button" className="secondary-button" onClick={() => setThemeDraft(undefined)}>
                          Cancel
                        </button>
                        <button type="submit" className="create-project-button">
                          Save and apply
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="empty">Loading themes...</p>
            )}
          </section>
        </div>
      ) : null}

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

      {isCreateRecordDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-record-title">
            <h2 id="create-record-title">Create record</h2>
            <form className="new-record-form" onSubmit={(event) => void createRecord(event)}>
              <label htmlFor="new-record-filename">Filename</label>
              <input
                id="new-record-filename"
                autoFocus
                value={newRecordFilename}
                onChange={(event) => {
                  setNewRecordFilename(event.target.value);
                  setNewRecordFilenameError(undefined);
                }}
                placeholder="new-record.json"
              />
              {newRecordFilenameError ? (
                <p className="form-error" role="alert">
                  {newRecordFilenameError}
                </p>
              ) : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setNewRecordFilename('');
                    setNewRecordFilenameError(undefined);
                    setCreateRecordDialogOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="create-project-button" disabled={!newRecordFilename.trim()}>
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
            <h2 id="feedback-config-title">Project configuration</h2>
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
      {saveWarning ? (
        <section className="warning-panel" role="alert" tabIndex={0}>
          {saveWarning}
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
            {selectedProjectId && project ? (
              <div className="records-header-actions">
                <button
                  type="button"
                  className="create-record-button action-icon-button"
                  aria-label="Create record"
                  data-tooltip="Create record"
                  disabled={status === 'loading'}
                  onClick={() => void requestCreateRecord()}
                >
                  <span aria-hidden="true">+</span>
                </button>
                <button
                  type="button"
                  className="refresh-records-button action-icon-button"
                  aria-label="Refresh records"
                  data-tooltip="Refresh records"
                  disabled={status === 'loading'}
                  onClick={() => void requestRefreshRecords()}
                >
                  <span aria-hidden="true">↻</span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="records-list-container" role="region" aria-label="Records list" tabIndex={0}>
            {records.length === 0 ? <p className="empty">No records loaded.</p> : null}
            <ul aria-label="Records">
              {records.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) {
                        recordButtonRefs.current.set(item.id, element);
                      } else {
                        recordButtonRefs.current.delete(item.id);
                      }
                    }}
                    className={item.id === selectedRecordId ? 'selected record-button' : 'record-button'}
                    onClick={() => void requestRecordOpen(item.id)}
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
          <div className="details-header">
            <h2 id="details-heading">Record details</h2>
            <div className="details-header-actions">
              <label className="details-toggle">
                <input
                  type="checkbox"
                  checked={showExtraSchemaFields}
                  onChange={(event) => setShowExtraSchemaFields(event.target.checked)}
                />
                Show fields not in schema
              </label>
              {record ? (
                <div className="save-controls">
                  <button
                    type="button"
                    className="create-record-button action-icon-button"
                    aria-label="Save"
                    data-tooltip="Save record"
                    disabled={!hasUnsavedChanges || status === 'loading'}
                    onClick={() => void saveSelectedRecordChanges()}
                  >
                    <SaveIcon />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {status === 'loading' ? <p aria-live="polite">Loading...</p> : null}
          {activeQueueWork?.bannerVisible && record?.recordId === activeQueueWork.recordId && selectedProjectId === activeQueueWork.projectId ? (
            <section className="queue-instructions" aria-label="Queue instructions">
              <p>{activeQueueWork.instructions}</p>
              <button type="button" className="secondary-button" onClick={() => setActiveQueueWork((current) => (current ? { ...current, bannerVisible: false } : current))}>
                Dismiss
              </button>
            </section>
          ) : null}
          {record ? (
            <RecordDetails
              record={record}
              feedbackConfig={feedbackConfig}
              projectUser={projectUser}
              showExtraSchemaFields={showExtraSchemaFields}
              onSubmitFeedback={submitFeedback}
              onInlineEdit={updateInlineRecordValue}
              onComputeTags={computeSelectedRecordTags}
              feedbackDrafts={feedbackDrafts}
              onChangeFeedbackDraft={changeFeedbackDraft}
              tagDefinitions={project?.tagDefinitions ?? []}
            />
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
                className={`message ${message.role}${message.id === pendingAssistantMessageId ? ' pending' : ''}${message.id === pendingAssistantMessageId && !message.content ? ' waiting' : ''}`}
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
            {chatAttachments.length > 0 || chatAttachmentError ? (
              <div className="chat-attachments" aria-label="Selected chat attachments">
                {chatAttachmentError ? (
                  <p className="attachment-error" role="alert">
                    {chatAttachmentError}
                  </p>
                ) : null}
                {chatAttachments.map((attachment) => (
                  <span className="attachment-chip" key={attachment.id}>
                    <span>{attachment.name}</span>
                    <small>{formatBytes(attachment.sizeBytes)}</small>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => removeChatAttachment(attachment.id)}
                      disabled={chatState === 'streaming'}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="chat-action-row">
              <div className="chat-login-actions" aria-label="Login actions">
                <button
                  type="button"
                  className="github-login-button chat-login-button action-icon-button"
                  aria-label={loginInProgress ? 'Waiting for GitHub login' : 'Login to GitHub'}
                  data-tooltip={loginInProgress ? 'Waiting for GitHub login' : 'Login to GitHub'}
                  data-tooltip-align="left"
                  onClick={() => void continueWithGitHub()}
                  disabled={chatState === 'streaming' || loginInProgress}
                >
                  <GitHubLogo />
                </button>
              </div>
              <div className="chat-actions" aria-label="Chat actions">
                <button
                  type="button"
                  className="secondary-button action-icon-button"
                  aria-label="Attach"
                  data-tooltip="Attach files"
                  onClick={() => void selectChatAttachments()}
                  disabled={chatState === 'streaming' || agentUnavailable}
                >
                  <AttachIcon />
                </button>
                <button
                  type="button"
                  className="secondary-button action-icon-button"
                  aria-label="Clear"
                  data-tooltip="Clear chat"
                  onClick={clearChat}
                  disabled={messages.length === 0 || chatState === 'streaming'}
                >
                  <span aria-hidden="true" className="clear-icon-text">CLR</span>
                </button>
                <button
                  type="button"
                  className="secondary-button action-icon-button"
                  aria-label="Cancel"
                  data-tooltip="Cancel response"
                  disabled={chatState !== 'streaming'}
                  onClick={() => void cancelChat()}
                >
                  <span aria-hidden="true">■</span>
                </button>
                <button
                  type="submit"
                  className="action-icon-button"
                  aria-label="Send"
                  data-tooltip="Send message"
                  data-tooltip-align="right"
                  disabled={!canSendChat}
                >
                  <span aria-hidden="true">↵</span>
                </button>
              </div>
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

      {pendingNavigation ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal warning-modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title">
            <h2 id="unsaved-changes-title">Unsaved changes</h2>
            <p className="modal-help">
              {pendingNavigationBlockedByChat
                ? 'The agent is still running and may stage record changes. Stay here, then cancel the response or wait for it to finish before leaving.'
                : 'Save this record before leaving, or discard the unsaved changes to continue.'}
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={cancelPendingNavigation}>
                Stay
              </button>
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={pendingNavigationBlockedByChat}
                onClick={() => void discardAndContinue()}
              >
                Discard changes
              </button>
              <button
                type="button"
                className="create-project-button"
                disabled={pendingNavigationBlockedByChat}
                onClick={() => void saveAndContinue()}
              >
                Save
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

const SaveIcon = () => (
  <svg className="action-svg-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path
      fill="currentColor"
      d="M2 1.5A1.5 1.5 0 0 1 3.5 0h7.38c.4 0 .78.16 1.06.44l1.62 1.62c.28.28.44.66.44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 14.5v-13ZM4 1.5V6h7V1.62L10.88 1.5H10V4H8V1.5H4Zm0 8V15h8V9.5H4Z"
    />
  </svg>
);

const ComputeTagsIcon = () => (
  <svg className="action-svg-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path
      fill="currentColor"
      d="M8 1.5 9.53 5l3.72.43-2.8 2.5.74 3.67L8 9.7l-3.19 1.9.74-3.67-2.8-2.5L6.47 5 8 1.5Zm0 3.02-.63 1.43-1.53.18 1.15 1.03-.3 1.51L8 7.89l1.31.78-.3-1.51 1.15-1.03-1.53-.18L8 4.52ZM2.5 12h11v1.5h-11V12Z"
    />
  </svg>
);

const ThemeIcon = () => (
  <svg className="action-svg-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path
      fill="currentColor"
      d="M8 1.25a6.75 6.75 0 0 0 0 13.5h.7c.89 0 1.55-.28 1.91-.8.36-.52.39-1.2.08-1.92-.13-.3-.11-.5.05-.66.17-.17.46-.26.81-.26H12A2.75 2.75 0 0 0 14.75 8.36 7.1 7.1 0 0 0 8 1.25Zm0 1.5a5.6 5.6 0 0 1 5.25 5.61c0 .69-.56 1.25-1.25 1.25h-.45c-.72 0-1.39.24-1.88.72-.57.56-.71 1.38-.36 2.29.1.24.09.41.07.45-.03.05-.21.18-.68.18H8a5.25 5.25 0 0 1 0-10.5ZM4.75 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm2.5-1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM10.75 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5.5 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
    />
  </svg>
);

const QueueGetIcon = () => (
  <svg className="action-svg-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path fill="currentColor" d="M7.25 2h1.5v7.4l2.72-2.72 1.06 1.06L8 12.27 3.47 7.74l1.06-1.06L7.25 9.4V2ZM3 13.5h10V15H3v-1.5Z" />
  </svg>
);

const AttachIcon = () => (
  <svg className="action-svg-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
    <path
      fill="currentColor"
      d="M4.47 10.78 10.9 4.35a2.25 2.25 0 0 1 3.18 3.18l-7.25 7.25a4 4 0 0 1-5.66-5.66l7.07-7.07 1.06 1.06-7.07 7.07a2.5 2.5 0 0 0 3.54 3.54l7.25-7.25a.75.75 0 0 0-1.06-1.06l-6.43 6.43a1.25 1.25 0 0 1-1.77-1.77l5.66-5.66 1.06 1.06-5.66 5.66a.25.25 0 0 0-.07.18.24.24 0 0 0 .07.17.25.25 0 0 0 .35 0Z"
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
  const assignedMappings = new Map(entries.filter((entry) => entry.mapping).map((entry) => [entry.mapping, entry.path]));
  const supportsMapping = (entry: FeedbackConfigEntry): boolean => !entry.target.endsWith(' > *');
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
            <th>EDIT MODE</th>
            <th>PRESENTATION</th>
            <th>MAPPING</th>
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
              <td>
                {entry.editMode === undefined ? null : (
                  <select
                    aria-label={`${entry.target} edit mode`}
                    value={entry.editMode}
                    onChange={(event) => updateEntry(entry.path, { editMode: event.target.value as FeedbackEditMode })}
                  >
                    {FEEDBACK_EDIT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td>
                <select
                  aria-label={`${entry.target} presentation`}
                  value={entry.presentation ?? ''}
                  onChange={(event) => updateEntry(entry.path, { presentation: event.target.value ? (event.target.value as FeedbackConfigEntry['presentation']) : undefined })}
                >
                  <option value="">none</option>
                  {FIELD_PRESENTATIONS.map((presentation) => (
                    <option key={presentation} value={presentation}>
                      {presentation}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {supportsMapping(entry) ? (
                  <select
                    aria-label={`${entry.target} canonical mapping`}
                    value={entry.mapping ?? ''}
                    onChange={(event) => updateEntry(entry.path, { mapping: event.target.value ? (event.target.value as FeedbackConfigEntry['mapping']) : undefined })}
                  >
                    <option value="">none</option>
                    {CANONICAL_MAPPINGS.map((mapping) => (
                      <option key={mapping} value={mapping} disabled={assignedMappings.has(mapping) && assignedMappings.get(mapping) !== entry.path}>
                        {mapping}
                      </option>
                    ))}
                  </select>
                ) : null}
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
  showExtraSchemaFields,
  onSubmitFeedback,
  onInlineEdit,
  onComputeTags,
  feedbackDrafts,
  onChangeFeedbackDraft,
  tagDefinitions
}: {
  record: RecordDetail;
  feedbackConfig: FeedbackConfig | undefined;
  projectUser: ProjectUser | undefined;
  showExtraSchemaFields: boolean;
  onSubmitFeedback: (input: FeedbackSubmissionInput) => Promise<void>;
  onInlineEdit: (node: Extract<RenderNode, { kind: 'array' | 'value' | 'raw' }>, value: string) => Promise<void>;
  onComputeTags: () => Promise<void>;
  feedbackDrafts: FeedbackDrafts;
  onChangeFeedbackDraft: (path: string, draft: FeedbackDraft) => void;
  tagDefinitions: TagDefinition[];
}) => {
  const [activeTabId, setActiveTabId] = useState('overview');
  const history = record.feedbackHistory ?? {};
  const nodeTabs = useMemo(() => collectTurnNodeTabs(record.renderTree, feedbackConfig), [record.renderTree, feedbackConfig]);
  const activeNodeTab = nodeTabs.find((tab) => tab.id === activeTabId);
  const turnsPath = turnsMappingPath(feedbackConfig);
  const showTurnTabs = nodeTabs.length > 0;

  useEffect(() => {
    setActiveTabId('overview');
  }, [record.projectId, record.recordId]);

  useEffect(() => {
    if (activeTabId !== 'overview' && !activeNodeTab) {
      setActiveTabId('overview');
    }
  }, [activeNodeTab, activeTabId]);

  return (
    <InlineEditContext.Provider value={onInlineEdit}>
      {record.validationIssues.length > 0 ? (
        <section className="validation" aria-label="Validation errors">
          <h3>Validation errors</h3>
          <ul>
            {record.validationIssues.map((issue, index) => (
              <li key={`${issue.path}-${issue.keyword}-${index}`}>{formatValidationIssue(issue)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {showTurnTabs ? (
        <div className="node-tabs" role="tablist" aria-label="Record detail tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTabId === 'overview'}
            className={activeTabId === 'overview' ? 'node-tab active' : 'node-tab'}
            onClick={() => setActiveTabId('overview')}
          >
            Overview
          </button>
          {nodeTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTabId === tab.id}
              className={activeTabId === tab.id ? 'node-tab active' : 'node-tab'}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className={showTurnTabs ? 'node-tab-panel' : undefined} role={showTurnTabs ? 'tabpanel' : undefined}>
        {showTurnTabs && activeNodeTab ? (
          <RenderTreeRoot
            node={activeNodeTab.node}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            onComputeTags={onComputeTags}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            tagDefinitions={tagDefinitions}
          />
        ) : (
          <RenderTreeRoot
            node={record.renderTree}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            onComputeTags={onComputeTags}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            tagDefinitions={tagDefinitions}
            collapseEvidence
            omitArrayItemsForPath={showTurnTabs ? turnsPath : undefined}
          />
        )}
      </div>
    </InlineEditContext.Provider>
  );
};

const InlineEditContext = React.createContext<((node: Extract<RenderNode, { kind: 'array' | 'value' | 'raw' }>, value: string) => Promise<void>) | undefined>(
  undefined
);

const collectTurnNodeTabs = (node: RenderNode, feedbackConfig?: FeedbackConfig): NodeTab[] => {
  const turnsPath = turnsMappingPath(feedbackConfig);
  const turnsNode = turnsPath ? findArrayNodeByPath(node, turnsPath) : undefined;
  if (!turnsNode) {
    return [];
  }
  return turnsNode.items.map((item, index) => ({
    id: nodeTabId(item),
    label: `Turn ${index}`,
    node: item
  }));
};

const nodeTabId = (node: RenderNode): string => `node:${node.path ?? node.label}`;

const turnsMappingPath = (feedbackConfig?: FeedbackConfig): string | undefined =>
  Object.values(feedbackConfig?.properties ?? {}).find((entry) => entry.mapping === 'turns')?.path;

const findArrayNodeByPath = (node: RenderNode, path: string): Extract<RenderNode, { kind: 'array' }> | undefined => {
  if (node.kind === 'array' && node.path === path) {
    return node;
  }
  if (node.kind === 'object') {
    for (const child of node.children) {
      const match = findArrayNodeByPath(child, path);
      if (match) {
        return match;
      }
    }
  }
  if (node.kind === 'array') {
    for (const item of node.items) {
      const match = findArrayNodeByPath(item, path);
      if (match) {
        return match;
      }
    }
  }
  return undefined;
};

const RenderTreeRoot = ({
  node,
  feedbackConfig,
  history,
  projectUser,
  showExtraSchemaFields,
  onSubmitFeedback,
  onComputeTags,
  feedbackDrafts,
  onChangeFeedbackDraft,
  tagDefinitions = [],
  collapseEvidence = false,
  omitArrayItemsForPath
}: {
  node: RenderNode;
  feedbackConfig?: FeedbackConfig;
  history: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  showExtraSchemaFields: boolean;
  onSubmitFeedback: (input: FeedbackSubmissionInput) => Promise<void>;
  onComputeTags?: () => Promise<void>;
  feedbackDrafts?: FeedbackDrafts;
  onChangeFeedbackDraft?: (path: string, draft: FeedbackDraft) => void;
  tagDefinitions?: TagDefinition[];
  collapseEvidence?: boolean;
  omitArrayItemsForPath?: string;
}) => {
  if (node.kind === 'object') {
    return (
      <>
        {node.description ? <p>{node.description}</p> : null}
        {visibleRenderNodes(node.children, showExtraSchemaFields).map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            onComputeTags={onComputeTags}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            tagDefinitions={tagDefinitions}
            collapseEvidence={collapseEvidence}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
        ))}
      </>
    );
  }
  return (
    <RenderTree
      node={node}
      feedbackConfig={feedbackConfig}
      history={history}
      projectUser={projectUser}
      showExtraSchemaFields={showExtraSchemaFields}
      onSubmitFeedback={onSubmitFeedback}
      onComputeTags={onComputeTags}
      feedbackDrafts={feedbackDrafts}
      onChangeFeedbackDraft={onChangeFeedbackDraft}
      tagDefinitions={tagDefinitions}
      collapseEvidence={collapseEvidence}
      omitArrayItemsForPath={omitArrayItemsForPath}
    />
  );
};

const RenderTree = ({
  node,
  collapseObject = false,
  feedbackConfig,
  history,
  projectUser,
  showExtraSchemaFields = true,
  onSubmitFeedback,
  onComputeTags,
  feedbackDrafts,
  onChangeFeedbackDraft,
  tagDefinitions = [],
  collapseEvidence = false,
  omitArrayItemsForPath
}: {
  node: RenderNode;
  collapseObject?: boolean;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  showExtraSchemaFields?: boolean;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  onComputeTags?: () => Promise<void>;
  feedbackDrafts?: FeedbackDrafts;
  onChangeFeedbackDraft?: (path: string, draft: FeedbackDraft) => void;
  tagDefinitions?: TagDefinition[];
  collapseEvidence?: boolean;
  omitArrayItemsForPath?: string;
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
      const feedbackNode = { ...node, label: identifier ?? node.label };
      const summaryFeedbackRatings = feedbackRatingsForNodeSummary(node.path, history, feedbackDrafts);
      return (
        <details className="node collapsible-node">
          <summary>
            <span className="field-heading array-item-summary">
              {node.description ? <span className="field-description">{node.description}</span> : null}
              <span className="array-item-identifier">{identifier ?? node.label}</span>
            </span>
            <RatingSummary ratings={summaryFeedbackRatings} />
          </summary>
          {issues}
          <FeedbackPanel
            node={feedbackNode}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            draft={node.path ? feedbackDrafts?.[node.path] : undefined}
            onChangeDraft={onChangeFeedbackDraft}
          />
          {visibleRenderNodes(node.children, showExtraSchemaFields).map((child) => (
            <RenderTree
              key={child.path ?? child.label}
              node={child}
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              showExtraSchemaFields={showExtraSchemaFields}
              onSubmitFeedback={onSubmitFeedback}
              onComputeTags={onComputeTags}
              feedbackDrafts={feedbackDrafts}
              onChangeFeedbackDraft={onChangeFeedbackDraft}
              tagDefinitions={tagDefinitions}
              collapseEvidence={collapseEvidence}
              omitArrayItemsForPath={omitArrayItemsForPath}
            />
          ))}
        </details>
      );
    }
    return (
      <section className="node">
        <FieldHeading label={node.label} description={node.description} />
        {issues}
        <FeedbackPanel
          node={node}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          onSubmitFeedback={onSubmitFeedback}
          draft={node.path ? feedbackDrafts?.[node.path] : undefined}
          onChangeDraft={onChangeFeedbackDraft}
        />
        {visibleRenderNodes(node.children, showExtraSchemaFields).map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            onComputeTags={onComputeTags}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            tagDefinitions={tagDefinitions}
            collapseEvidence={collapseEvidence}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
        ))}
      </section>
    );
  }
  if (node.kind === 'array') {
    const editMode = editModeForNode(node, feedbackConfig);
    const stringArray = isStringArrayNode(node);
    const tagsPresentation = stringArray && isTagsPresentationNode(node, feedbackConfig);
    const [localStringArrayCount, setLocalStringArrayCount] = useState<number | undefined>(undefined);
    if (node.presentation === 'evidence-list') {
      return (
        <EvidenceList
          node={node}
          issues={issues}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          showExtraSchemaFields={showExtraSchemaFields}
          onSubmitFeedback={onSubmitFeedback}
          feedbackDrafts={feedbackDrafts}
          onChangeFeedbackDraft={onChangeFeedbackDraft}
          omitArrayItemsForPath={omitArrayItemsForPath}
        />
      );
    }
    return (
      <section className="node array-node">
        <FieldHeading
          label={node.label}
          description={node.description}
          meta={formatItemCount(stringArray ? (localStringArrayCount ?? stringArrayItemCount(node, node.path ? feedbackDrafts?.[node.path] : undefined)) : node.items.length)}
          editMode={editMode}
        />
        {issues}
        <FeedbackPanel
          node={node}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          onSubmitFeedback={onSubmitFeedback}
          draft={node.path ? feedbackDrafts?.[node.path] : undefined}
          onChangeDraft={onChangeFeedbackDraft}
          suppressLoggedEdit={stringArray}
        />
        {node.path && node.path === omitArrayItemsForPath ? (
          <p className="array-items-omitted">(shown in tabs)</p>
        ) : tagsPresentation ? (
          <TagsPresentation
            node={node}
            editMode={editMode}
            tagDefinitions={tagDefinitions}
            onComputeTags={onComputeTags}
            draft={node.path ? feedbackDrafts?.[node.path] : undefined}
            onChangeDraft={onChangeFeedbackDraft}
            onChangeCount={setLocalStringArrayCount}
          />
        ) : stringArray ? (
          <StringArrayRows
            node={node}
            editMode={editMode}
            draft={node.path ? feedbackDrafts?.[node.path] : undefined}
            onChangeDraft={onChangeFeedbackDraft}
            onChangeCount={setLocalStringArrayCount}
          />
        ) : visibleRenderNodes(node.items, showExtraSchemaFields).length === 0 ? (
          <output>{NOT_SET_LABEL}</output>
        ) : (
          visibleRenderNodes(node.items, showExtraSchemaFields).map((child) => (
          <RenderTree
            key={child.path ?? child.label}
            node={child}
            collapseObject={child.kind === 'object'}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            tagDefinitions={tagDefinitions}
            collapseEvidence={collapseEvidence}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
          ))
        )}
      </section>
    );
  }
  if (node.kind === 'raw') {
    if (isCollapsiblePresentation(node.presentation)) {
      const extraSchemaField = isExtraSchemaField(node);
      return (
        <CollapsiblePresentationField node={node} meta={extraSchemaField ? '(not in schema)' : undefined} editMode={editModeForNode(node, feedbackConfig)}>
          {extraSchemaField ? null : <p className="raw-reason">{node.reason}</p>}
          {editModeForNode(node, feedbackConfig) === 'inline' ? (
            <InlineEditableValue node={node} className={presentationOutputClassName(node.presentation)} />
          ) : (
            <pre className={presentationOutputClassName(node.presentation)}>{formatRawDisplayValue(node.value)}</pre>
          )}
          <FeedbackPanel
            node={node}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            onSubmitFeedback={onSubmitFeedback}
            draft={node.path ? feedbackDrafts?.[node.path] : undefined}
            onChangeDraft={onChangeFeedbackDraft}
          />
        </CollapsiblePresentationField>
      );
    }
    const extraSchemaField = isExtraSchemaField(node);
    const editMode = editModeForNode(node, feedbackConfig);
    return (
      <section className={fieldClassName(node.presentation)}>
        <FieldHeading label={node.label} description={node.description} meta={extraSchemaField ? '(not in schema)' : undefined} editMode={editMode} />
        {issues}
        {extraSchemaField ? null : <p className="raw-reason">{node.reason}</p>}
        {editMode === 'inline' ? (
          <InlineEditableValue node={node} className={presentationOutputClassName(node.presentation)} />
        ) : (
          <pre className={presentationOutputClassName(node.presentation)}>{formatRawDisplayValue(node.value)}</pre>
        )}
        <FeedbackPanel
          node={node}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          onSubmitFeedback={onSubmitFeedback}
          draft={node.path ? feedbackDrafts?.[node.path] : undefined}
          onChangeDraft={onChangeFeedbackDraft}
        />
      </section>
    );
  }
  if (isCollapsiblePresentation(node.presentation)) {
    return (
      <CollapsiblePresentationField node={node} editMode={editModeForNode(node, feedbackConfig)}>
        {issues}
        {editModeForNode(node, feedbackConfig) === 'inline' ? (
          <InlineEditableValue node={node} className={presentationOutputClassName(node.presentation)} />
        ) : (
          <output className={presentationOutputClassName(node.presentation)}>{formatDisplayValue(node.value)}</output>
        )}
        <FeedbackPanel
          node={node}
          feedbackConfig={feedbackConfig}
          history={history}
          projectUser={projectUser}
          onSubmitFeedback={onSubmitFeedback}
          draft={node.path ? feedbackDrafts?.[node.path] : undefined}
          onChangeDraft={onChangeFeedbackDraft}
        />
      </CollapsiblePresentationField>
    );
  }
  const editMode = editModeForNode(node, feedbackConfig);
  return (
    <section className={fieldClassName(node.presentation)}>
      <FieldHeading label={node.label} description={node.description} editMode={editMode} />
      {issues}
      {editMode === 'inline' ? (
        <InlineEditableValue node={node} className={presentationOutputClassName(node.presentation)} />
      ) : (
        <ValueOutput value={node.value} className={presentationOutputClassName(node.presentation)} />
      )}
      <FeedbackPanel
        node={node}
        feedbackConfig={feedbackConfig}
        history={history}
        projectUser={projectUser}
        onSubmitFeedback={onSubmitFeedback}
        draft={node.path ? feedbackDrafts?.[node.path] : undefined}
        onChangeDraft={onChangeFeedbackDraft}
      />
    </section>
  );
};

const fieldClassName = (presentation: RenderNode['presentation']): string =>
  presentation ? `field presentation-field presentation-${presentation}` : 'field';

const presentationOutputClassName = (presentation: RenderNode['presentation']): string | undefined => (presentation ? 'presentation-output' : undefined);

const isCollapsiblePresentation = (presentation: RenderNode['presentation']): boolean => presentation === 'chat-request' || presentation === 'chat-response';

const CollapsiblePresentationField = ({ node, children, meta, editMode }: { node: RenderNode; children: React.ReactNode; meta?: string; editMode?: FeedbackEditMode }) => (
  <details className={fieldClassName(node.presentation)} open>
    <summary>
      <FieldHeading label={node.label} description={node.description} meta={meta} editMode={editMode} />
    </summary>
    {children}
  </details>
);

const EvidenceList = ({
  node,
  issues,
  feedbackConfig,
  history,
  projectUser,
  showExtraSchemaFields,
  onSubmitFeedback,
  feedbackDrafts,
  onChangeFeedbackDraft,
  collapseItems = true,
  omitArrayItemsForPath
}: {
  node: Extract<RenderNode, { kind: 'array' }>;
  issues: React.ReactNode;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  showExtraSchemaFields: boolean;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  feedbackDrafts?: FeedbackDrafts;
  onChangeFeedbackDraft?: (path: string, draft: FeedbackDraft) => void;
  collapseItems?: boolean;
  omitArrayItemsForPath?: string;
}) => (
  <details className="node array-node evidence-list" open>
    <summary>
      <FieldHeading label={node.label} description={node.description} meta={formatItemCount(node.items.length)} />
    </summary>
    {issues}
    <FeedbackPanel
      node={node}
      feedbackConfig={feedbackConfig}
      history={history}
      projectUser={projectUser}
      onSubmitFeedback={onSubmitFeedback}
      draft={node.path ? feedbackDrafts?.[node.path] : undefined}
      onChangeDraft={onChangeFeedbackDraft}
    />
    <div className="evidence-items">
      {visibleRenderNodes(node.items, showExtraSchemaFields).map((item, index) =>
        item.kind === 'object' ? (
          <EvidenceCard
            key={item.path ?? item.label}
            node={item}
            index={index}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            collapseEvidence={collapseItems}
            collapsed={collapseItems}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
        ) : (
          <RenderTree
            key={item.path ?? item.label}
            node={item}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            collapseEvidence={collapseItems}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
        )
      )}
    </div>
  </details>
);

const EvidenceCard = ({
  node,
  index,
  feedbackConfig,
  history,
  projectUser,
  showExtraSchemaFields,
  onSubmitFeedback,
  feedbackDrafts,
  onChangeFeedbackDraft,
  collapseEvidence = false,
  collapsed = false,
  omitArrayItemsForPath
}: {
  node: Extract<RenderNode, { kind: 'object' }>;
  index: number;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  showExtraSchemaFields: boolean;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  feedbackDrafts?: FeedbackDrafts;
  onChangeFeedbackDraft?: (path: string, draft: FeedbackDraft) => void;
  collapseEvidence?: boolean;
  collapsed?: boolean;
  omitArrayItemsForPath?: string;
}) => {
  const fields = visibleRenderNodes(node.children, showExtraSchemaFields).map((child) => ({ node: child, editMode: editModeForNode(child, feedbackConfig) }));
  const readonlyFields = fields.filter((field) => field.editMode === 'none');
  const editableFields = fields.filter((field) => field.editMode !== 'none');
  const title = getObjectIdentifier(node) ?? `Item ${index}`;
  const feedbackNode = { ...node, label: title };
  const summaryFeedbackRatings = feedbackRatingsForNodeSummary(node.path, history, feedbackDrafts);
  return (
    <details className="evidence-card" open={!collapsed}>
      <summary className="evidence-card-header">
        <span className="evidence-card-title">
          <h4>{title}</h4>
          <RatingSummary ratings={summaryFeedbackRatings} />
        </span>
      </summary>
      <FeedbackPanel
        node={feedbackNode}
        feedbackConfig={feedbackConfig}
        history={history}
        projectUser={projectUser}
        onSubmitFeedback={onSubmitFeedback}
        draft={node.path ? feedbackDrafts?.[node.path] : undefined}
        onChangeDraft={onChangeFeedbackDraft}
      />
      {readonlyFields.length > 0 ? (
        <dl className="evidence-readonly-grid" aria-label="Read-only evidence fields">
          {readonlyFields.map(({ node: child, editMode }) => (
           <EvidenceField
             key={child.path ?? child.label}
             node={child}
             editMode={editMode}
             feedbackConfig={feedbackConfig}
             history={history}
             projectUser={projectUser}
             showExtraSchemaFields={showExtraSchemaFields}
             onSubmitFeedback={onSubmitFeedback}
             feedbackDrafts={feedbackDrafts}
             onChangeFeedbackDraft={onChangeFeedbackDraft}
             collapseEvidence={collapseEvidence}
             omitArrayItemsForPath={omitArrayItemsForPath}
           />
          ))}
        </dl>
      ) : null}
      {editableFields.length > 0 ? (
        <dl className="evidence-editable-fields" aria-label="Editable evidence fields">
          {editableFields.map(({ node: child, editMode }) => (
          <EvidenceField
            key={child.path ?? child.label}
            node={child}
            editMode={editMode}
            feedbackConfig={feedbackConfig}
            history={history}
            projectUser={projectUser}
            showExtraSchemaFields={showExtraSchemaFields}
            onSubmitFeedback={onSubmitFeedback}
            feedbackDrafts={feedbackDrafts}
            onChangeFeedbackDraft={onChangeFeedbackDraft}
            collapseEvidence={collapseEvidence}
            omitArrayItemsForPath={omitArrayItemsForPath}
          />
          ))}
        </dl>
      ) : null}
    </details>
  );
};

const EvidenceField = ({
  node,
  editMode,
  feedbackConfig,
  history,
  projectUser,
  showExtraSchemaFields,
  onSubmitFeedback,
  feedbackDrafts,
  onChangeFeedbackDraft,
  collapseEvidence = false,
  omitArrayItemsForPath
}: {
  node: RenderNode;
  editMode: FeedbackEditMode;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  showExtraSchemaFields: boolean;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  feedbackDrafts?: FeedbackDrafts;
  onChangeFeedbackDraft?: (path: string, draft: FeedbackDraft) => void;
  collapseEvidence?: boolean;
  omitArrayItemsForPath?: string;
}) => {
  return (
    <div className={`evidence-field ${editMode !== 'none' ? 'editable' : 'readonly'} ${isEvidenceContentField(node) ? 'evidence-field-content' : ''}`}>
      <dt>
        <span>{node.label}</span>
        <span className={`editability-badge ${editMode !== 'none' ? 'editable' : 'readonly'}`}>{editabilityLabel(editMode)}</span>
      </dt>
      {editMode === 'logged' ? null : (
        <dd>
          {editMode === 'inline' && (node.kind === 'value' || node.kind === 'raw') ? (
            <InlineEditableValue node={node} />
          ) : node.kind === 'value' || node.kind === 'raw' ? (
            <DisplayValue value={node.value} linkClassName="evidence-value-link" />
          ) : (
            <RenderTree
              node={node}
              feedbackConfig={feedbackConfig}
              history={history}
              projectUser={projectUser}
              showExtraSchemaFields={showExtraSchemaFields}
              onSubmitFeedback={onSubmitFeedback}
              feedbackDrafts={feedbackDrafts}
              onChangeFeedbackDraft={onChangeFeedbackDraft}
              collapseEvidence={collapseEvidence}
              omitArrayItemsForPath={omitArrayItemsForPath}
            />
          )}
        </dd>
      )}
      <FeedbackPanel
        node={node}
        feedbackConfig={feedbackConfig}
        history={history}
        projectUser={projectUser}
        onSubmitFeedback={onSubmitFeedback}
        draft={node.path ? feedbackDrafts?.[node.path] : undefined}
        onChangeDraft={onChangeFeedbackDraft}
        showEditDiff={editMode === 'logged'}
      />
    </div>
  );
};

const editModeForNode = (node: RenderNode, feedbackConfig?: FeedbackConfig): FeedbackEditMode => {
  const config = node.path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, node.path) : undefined;
  return config?.editMode ?? 'none';
};

const isTagsPresentationNode = (node: RenderNode, feedbackConfig?: FeedbackConfig): boolean => {
  const config = node.path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, node.path) : undefined;
  return node.presentation === 'tags' || config?.presentation === 'tags';
};

const editabilityLabel = (editMode: FeedbackEditMode): string =>
  editMode === 'inline' ? 'inline' : editMode === 'logged' ? 'logged' : 'read-only';

const isEvidenceContentField = (node: RenderNode): boolean => node.label.toLowerCase() === 'content';

const EXTRA_SCHEMA_FIELD_REASON = 'Field is present in data but not declared by schema.';

const isExtraSchemaField = (node: RenderNode): boolean => node.kind === 'raw' && node.reason === EXTRA_SCHEMA_FIELD_REASON;

const visibleRenderNodes = <Node extends RenderNode>(nodes: Node[], showExtraSchemaFields: boolean): Node[] =>
  showExtraSchemaFields ? nodes : nodes.filter((node) => !isExtraSchemaField(node));

const isStringArrayNode = (node: Extract<RenderNode, { kind: 'array' }>): boolean =>
  node.items.every((item) => item.kind === 'value' && (item.type === 'string' || typeof item.value === 'string' || item.value === undefined));

const FieldHeading = ({ label, description, meta, editMode }: { label: string; description?: string; meta?: string; editMode?: FeedbackEditMode }) => (
  <h3 className="field-heading">
    <span className="field-label">{label}</span>
    {description ? <span className="field-description">{description}</span> : null}
    {meta ? <span className="field-meta">{meta}</span> : null}
    {editMode && editMode !== 'none' ? <span className={`field-edit-mode field-edit-mode-${editMode}`}>{editMode}</span> : null}
  </h3>
);

const formatValidationIssue = (issue: ValidationIssue): string => `${formatValidationPath(issue.path)}: ${issue.message}`;

const formatValidationPath = (path: string): string => {
  if (!path || path === '/') {
    return 'Record';
  }
  return path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join(' > ');
};

const ValueOutput = ({ value, className }: { value: unknown; className?: string }) => {
  return <output className={className}><DisplayValue value={value} /></output>;
};

const DisplayValue = ({ value, linkClassName }: { value: unknown; linkClassName?: string }) => {
  const formatted = formatDisplayValue(value);
  return typeof value === 'string' && isHttpUrl(value) ? (
    <a href={value} target="_blank" rel="noreferrer" className={linkClassName}>
      {formatted}
    </a>
  ) : (
    <>{formatted}</>
  );
};

const InlineEditableValue = ({ node, className }: { node: Extract<RenderNode, { kind: 'value' | 'raw' }>; className?: string }) => {
  const initialValue = editableValue(node);
  const [value, setValue] = useState(initialValue);
  const focusedRef = useRef(false);
  const onInlineEdit = React.useContext(InlineEditContext);
  useEffect(() => {
    if (!focusedRef.current) {
      setValue(initialValue);
    }
  }, [initialValue, node.path]);
  const changeValue = (nextValue: string) => {
    setValue(nextValue);
    if (onInlineEdit) {
      void onInlineEdit(node, nextValue);
    }
  };
  if (node.kind === 'value' && node.enumValues) {
    const hasSelectedOption = node.enumValues.some((option) => formatValue(option) === value);
    return (
      <select
        aria-label={node.label}
        className="enum-select"
        value={value}
        onChange={(event) => changeValue(event.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
        }}
      >
        {hasSelectedOption ? null : (
          <option value="" disabled>
            (not set)
          </option>
        )}
        {node.enumValues.map((option) => (
          <option key={enumOptionValue(option)} value={formatValue(option)}>
            {formatValue(option)}
          </option>
        ))}
      </select>
    );
  }
  return (
    <textarea
      aria-label={node.label}
      className={`inline-edit-value${className ? ` ${className}` : ''}`}
      value={value}
      onChange={(event) => changeValue(event.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
      }}
      rows={Math.max(1, Math.min(8, value.split(/\r?\n/).length))}
    />
  );
};

const StringArrayRows = ({
  node,
  editMode,
  draft,
  onChangeDraft,
  onChangeCount
}: {
  node: Extract<RenderNode, { kind: 'array' }>;
  editMode: FeedbackEditMode;
  draft?: FeedbackDraft;
  onChangeDraft?: (path: string, draft: FeedbackDraft) => void;
  onChangeCount?: (count: number) => void;
}) => {
  const initialValue = editableValue(node);
  const draftValue = draft?.editValue;
  const editable = editMode === 'inline' || editMode === 'logged';
  const rowSource = editMode === 'logged' && draftValue !== undefined ? draftValue : initialValue;
  const initialRows = useMemo(() => stringArrayRowsFromText(rowSource, editable), [editable, rowSource]);
  const [rows, setRows] = useState(initialRows);
  const focusedRef = useRef(false);
  const onInlineEdit = React.useContext(InlineEditContext);
  useEffect(() => {
    if (!focusedRef.current) {
      setRows(initialRows);
      onChangeCount?.(countStringArrayRows(initialRows));
    }
  }, [initialRows, node.path, onChangeCount]);
  const changeValue = (index: number, nextValue: string) => {
    const nextRows = withTrailingEmptyRow(rows.map((row, rowIndex) => (rowIndex === index ? nextValue : row)));
    const nextValueText = serializeStringArrayRows(nextRows);
    setRows(nextRows);
    onChangeCount?.(countStringArrayRows(nextRows));
    if (editMode === 'inline' && onInlineEdit) {
      void onInlineEdit(node, nextValueText);
      return;
    }
    if (editMode === 'logged' && node.path && onChangeDraft) {
      onChangeDraft(node.path, normalizeFeedbackDraft({ ...draft, editValue: nextValueText }, initialValue));
    }
  };
  return (
    <div className="array-string-editor" aria-label={`${node.label} items`}>
      {rows.map((row, index) =>
        editable ? (
          <input
            key={index}
            aria-label={index === rows.length - 1 && row.trim() === '' ? `${node.label} new item` : `${node.label} item ${index + 1}`}
            className="inline-edit-value"
            type="text"
            value={row}
            onChange={(event) => changeValue(index, event.target.value)}
            onFocus={() => {
              focusedRef.current = true;
            }}
            onBlur={() => {
              focusedRef.current = false;
            }}
          />
        ) : (
          <output key={index} className="array-string-output">
            {formatDisplayValue(row)}
          </output>
        )
      )}
      {!editable && rows.length === 0 ? <output className="array-string-output">{NOT_SET_LABEL}</output> : null}
    </div>
  );
};

const TagsPresentation = ({
  node,
  editMode,
  tagDefinitions,
  onComputeTags,
  draft,
  onChangeDraft,
  onChangeCount
}: {
  node: Extract<RenderNode, { kind: 'array' }>;
  editMode: FeedbackEditMode;
  tagDefinitions: TagDefinition[];
  onComputeTags?: () => Promise<void>;
  draft?: FeedbackDraft;
  onChangeDraft?: (path: string, draft: FeedbackDraft) => void;
  onChangeCount?: (count: number) => void;
}) => {
  const initialValue = editableValue(node);
  const draftValue = draft?.editValue;
  const editable = editMode === 'inline' || editMode === 'logged';
  const tagSource = editMode === 'logged' && draftValue !== undefined ? draftValue : initialValue;
  const tags = useMemo(() => parseStringArrayEditValue(tagSource), [tagSource]);
  const manualNames = useMemo(() => new Set(tagDefinitions.map((definition) => definition.name)), [tagDefinitions]);
  const manualTags = tags.filter((tag) => manualNames.has(tag));
  const computedTags = tags.filter((tag) => !manualNames.has(tag));
  const availableDefinitions = tagDefinitions.filter((definition) => !tags.includes(definition.name));
  const onInlineEdit = React.useContext(InlineEditContext);

  useEffect(() => {
    onChangeCount?.(tags.length);
  }, [onChangeCount, tags.length]);

  const applyTags = (nextTags: string[]) => {
    const normalized = [...new Set(nextTags.map((tag) => tag.trim()).filter(Boolean))];
    const nextValueText = normalized.join('\n');
    onChangeCount?.(normalized.length);
    if (editMode === 'inline' && onInlineEdit) {
      void onInlineEdit(node, nextValueText);
      return;
    }
    if (editMode === 'logged' && node.path && onChangeDraft) {
      onChangeDraft(node.path, normalizeFeedbackDraft({ ...draft, editValue: nextValueText }, initialValue));
    }
  };

  const addManualTag = (name: string) => {
    if (!name || !manualNames.has(name) || name.length > MAX_TAG_LENGTH) {
      return;
    }
    const domain = manualTagDomain(name);
    const sameDomainTags =
      domain === undefined ? [] : tags.filter((tag) => tag !== name && manualNames.has(tag) && manualTagDomain(tag) === domain);
    if (tags.includes(name) || (sameDomainTags.length === 0 && tags.length >= MAX_TAGS_PER_RECORD)) {
      return;
    }
    if (sameDomainTags.length === 0) {
      applyTags([...tags, name]);
      return;
    }
    let replaced = false;
    applyTags(
      tags.flatMap((tag) => {
        if (!sameDomainTags.includes(tag)) {
          return [tag];
        }
        if (replaced) {
          return [];
        }
        replaced = true;
        return [name];
      })
    );
  };
  const removeManualTag = (name: string) => applyTags(tags.filter((tag) => tag !== name));

  return (
    <div className="tags-presentation" aria-label={`${node.label} tags`}>
      <TagGroup title="Computed tags" tags={computedTags} />
      <TagGroup title="Manual tags" tags={manualTags} onRemove={editable ? removeManualTag : undefined} />
      <div className="tag-controls">
        {editable ? (
          <label className="tag-add-control">
            <select
              aria-label={`Add ${node.label} manual tag`}
              value=""
              onChange={(event) => {
                addManualTag(event.target.value);
                event.currentTarget.value = '';
              }}
              disabled={availableDefinitions.length === 0 || tags.length >= MAX_TAGS_PER_RECORD}
            >
              <option value="">Choose a tag</option>
              {availableDefinitions.map((definition) => (
                <option key={definition.name} value={definition.name}>
                  {definition.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {onComputeTags ? (
          <button
            type="button"
            className="refresh-records-button action-icon-button"
            aria-label="Compute tags"
            data-tooltip="Compute tags"
            onClick={() => void onComputeTags()}
          >
            <ComputeTagsIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
};

const TagGroup = ({ title, tags, onRemove }: { title: string; tags: string[]; onRemove?: (tag: string) => void }) => (
  <section className="tag-group" aria-label={title}>
    <h4>{title}</h4>
    {tags.length === 0 ? (
      <output className="array-string-output">{NOT_SET_LABEL}</output>
    ) : (
      <div className="tag-chip-list">
        {tags.map((tag) => (
          <span key={tag} className="tag-chip">
            <span>{tag}</span>
            {onRemove ? (
              <button type="button" aria-label={`Remove ${tag}`} onClick={() => onRemove(tag)}>
                x
              </button>
            ) : null}
          </span>
        ))}
      </div>
    )}
  </section>
);

const manualTagDomain = (name: string): string | undefined => {
  const separatorIndex = name.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === name.length - 1) {
    return undefined;
  }
  return name.slice(0, separatorIndex);
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const FeedbackPanel = ({
  node,
  feedbackConfig,
  history,
  projectUser,
  onSubmitFeedback,
  draft,
  onChangeDraft,
  showEditDiff = false,
  suppressLoggedEdit = false
}: {
  node: RenderNode;
  feedbackConfig?: FeedbackConfig;
  history?: Record<string, FeedbackHistory>;
  projectUser?: ProjectUser;
  onSubmitFeedback?: (input: FeedbackSubmissionInput) => Promise<void>;
  draft?: FeedbackDraft;
  onChangeDraft?: (path: string, draft: FeedbackDraft) => void;
  showEditDiff?: boolean;
  suppressLoggedEdit?: boolean;
}) => {
  const path = node.path;
  const config = path && feedbackConfig ? feedbackConfigEntryForPath(feedbackConfig, path) : undefined;
  const nodeHistory = path ? history?.[path] : undefined;
  const initialEditValue = editableValue(node);
  const [localDraft, setLocalDraft] = useState<FeedbackDraft>({});
  const editInputId = useId();
  useEffect(() => {
    setLocalDraft({});
  }, [initialEditValue, path]);
  if (!path || !config || !onSubmitFeedback) {
    return null;
  }
  const allHistory = collectHistory(nodeHistory);
  const hasFeedbackControls = config.feedback !== 'none' || config.comments || (config.editMode === 'logged' && !suppressLoggedEdit);
  const usernameValid = projectUser?.valid === true;
  const showFeedbackControls = hasFeedbackControls && usernameValid;
  if (!showFeedbackControls && allHistory.length === 0) {
    return null;
  }
  const activeDraft = draft ?? localDraft;
  const feedbackValue = activeDraft.feedbackValue ?? '';
  const commentValue = activeDraft.commentValue ?? '';
  const editValue = activeDraft.editValue ?? initialEditValue;
  const historyFeedbackRatings = feedbackRatingsForCollectedHistory(allHistory);
  const changeDraft = (patch: FeedbackDraft) => {
    const nextDraft = normalizeFeedbackDraft({ ...activeDraft, ...patch }, initialEditValue);
    if (onChangeDraft) {
      onChangeDraft(path, nextDraft);
      return;
    }
    setLocalDraft(nextDraft);
  };

  return (
    <section className="feedback-panel" aria-label={`${node.label} feedback`}>
      {showFeedbackControls && config.feedback !== 'none' ? (
        <FeedbackValueInput mode={config.feedback} label={node.label} value={feedbackValue} onChange={(value) => changeDraft({ feedbackValue: value })} />
      ) : null}
      {showFeedbackControls && config.editMode === 'logged' && !suppressLoggedEdit ? (
        <div className="feedback-input">
          <label htmlFor={editInputId}>Edit</label>
          <EditInput id={editInputId} node={node} value={editValue} onChange={(value) => changeDraft({ editValue: value })} />
          {showEditDiff ? <EditDiff original={initialEditValue} edited={editValue} /> : null}
        </div>
      ) : null}
      {showFeedbackControls && config.comments ? (
        <label className="feedback-input">
          Comment
          <textarea value={commentValue} onChange={(event) => changeDraft({ commentValue: event.target.value })} rows={2} />
        </label>
      ) : null}
      {allHistory.length > 0 ? (
        <details className="feedback-history">
          <summary>
            <span>History ({allHistory.length})</span>
            <RatingSummary ratings={historyFeedbackRatings} />
          </summary>
          {allHistory.map((entry) => (
            <article key={`${entry.timestamp}-${entry.username}-${entry.feedback ?? ''}-${entry.comment ?? ''}-${entry.edit ?? ''}-${entry.original ?? ''}`} className="history-entry">
              {entry.original !== undefined ? (
                <p className="history-line">
                  <strong>original:</strong>
                  <span>{formatDisplayHistoryValue(entry.original, node)}</span>
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
                  <span>{formatDisplayHistoryValue(entry.edit, node)}</span>
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

type RatingSummaryItem = { visual: string; accessible: string };

const RatingSummary = ({ ratings }: { ratings: RatingSummaryItem[] }) => {
  if (ratings.length === 0) {
    return null;
  }
  return (
    <span className="history-rating-summary" aria-label={`Feedback ratings: ${ratings.map((rating) => rating.accessible).join(', ')}`}>
      {ratings.map((rating, index) => (
        <React.Fragment key={`${rating.accessible}-${index}`}>
          {index > 0 ? (
            <span className="history-rating-separator" aria-hidden="true">
              ,
            </span>
          ) : null}
          <span className="history-rating" aria-hidden="true">
            {rating.visual}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
};

const feedbackRatingsForHistory = (history: FeedbackHistory | undefined): RatingSummaryItem[] =>
  feedbackRatingsForCollectedHistory(collectHistory(history));

const feedbackRatingsForNodeSummary = (
  path: string | undefined,
  history: Record<string, FeedbackHistory> | undefined,
  drafts: FeedbackDrafts | undefined
): RatingSummaryItem[] => [
  ...(path && drafts?.[path]?.feedbackValue ? [feedbackRatingLabel(drafts[path].feedbackValue)] : []),
  ...feedbackRatingsForHistory(path ? history?.[path] : undefined)
];

const feedbackRatingsForCollectedHistory = (
  history: Array<{ username: string; timestamp: string; feedback?: string; comment?: string; edit?: string; original?: string }>
): RatingSummaryItem[] => history.flatMap((entry) => (entry.feedback ? [feedbackRatingLabel(entry.feedback)] : []));

const formatHistoryValue = (value: string, node: RenderNode): string => (node.kind === 'array' && isStringArrayNode(node) ? formatStringArrayHistoryValue(value) : value);

const formatDisplayHistoryValue = (value: string, node: RenderNode): string => {
  const formatted = formatHistoryValue(value, node);
  return formatted === '' ? '(empty)' : formatted;
};

const formatStringArrayHistoryValue = (value: string): string => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed.join(', ');
    }
  } catch {
    // Logged edits are stored as newline-delimited strings before they are saved.
  }
  return parseStringArrayEditValue(value).join(', ');
};

const feedbackRatingLabel = (value: string): { visual: string; accessible: string } => {
  if (value === 'thumbs_up' || value === 'up') {
    return { visual: '👍', accessible: 'thumbs up' };
  }
  if (value === 'thumbs_down' || value === 'down') {
    return { visual: '👎', accessible: 'thumbs down' };
  }
  if (/^[1-5]$/.test(value)) {
    const rating = Number(value);
    return { visual: '★'.repeat(rating), accessible: `${rating} star${rating === 1 ? '' : 's'}` };
  }
  return { visual: value, accessible: value.replace(/_/g, ' ') };
};

const EditDiff = ({ original, edited }: { original: string; edited: string }) => {
  if (original === edited) {
    return <p className="edit-diff-empty">No edits yet.</p>;
  }
  return (
    <div className="edit-diff" aria-label="Diff preview">
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
              onClick={() => {
                if (value === option.value) {
                  onChange('');
                }
              }}
              onChange={(event) => onChange(event.target.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
};

const EditInput = ({ id, node, value, onChange }: { id: string; node: RenderNode; value: string; onChange: (value: string) => void }) => {
  if (node.kind === 'value' && node.enumValues) {
    const hasSelectedOption = node.enumValues.some((option) => formatValue(option) === value);
    return (
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {hasSelectedOption ? null : (
          <option value="" disabled>
            (not set)
          </option>
        )}
        {node.enumValues.map((option) => (
          <option key={enumOptionValue(option)} value={formatValue(option)}>
            {formatValue(option)}
          </option>
        ))}
      </select>
    );
  }
  return <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={2} />;
};

const editableValue = (node: RenderNode): string =>
  node.kind === 'array' ? node.items.map((item) => (item.kind === 'value' ? formatValue(item.value) : '')).join('\n') : node.kind === 'value' || node.kind === 'raw' ? formatValue(node.value) : '';

const stringArrayRowsFromText = (value: string, editable: boolean): string[] => {
  const rows = value === '' ? [] : value.split(/\r?\n/).filter((row) => row.trim() !== '');
  return editable ? withTrailingEmptyRow(rows) : rows;
};

const withTrailingEmptyRow = (rows: string[]): string[] => (rows.length === 0 || rows[rows.length - 1].trim() !== '' ? [...rows, ''] : rows);

const serializeStringArrayRows = (rows: string[]): string => rows.map((row) => row.trim()).filter(Boolean).join('\n');

const countStringArrayRows = (rows: string[]): number => rows.filter((row) => row.trim() !== '').length;

const stringArrayItemCount = (node: Extract<RenderNode, { kind: 'array' }>, draft?: FeedbackDraft): number =>
  draft?.editValue !== undefined ? parseStringArrayEditValue(draft.editValue).length : node.items.length;

const coerceInlineEditValue = (node: Extract<RenderNode, { kind: 'array' | 'value' | 'raw' }>, value: string): unknown => {
  if (node.kind === 'array') {
    return parseStringArrayEditValue(value);
  }
  if (node.kind === 'value' && node.enumValues) {
    const option = node.enumValues.find((item) => enumOptionValue(item) === value || formatValue(item) === value);
    return option === undefined ? value : option;
  }
  if (node.kind === 'raw') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (node.type === 'number' || node.type === 'integer') {
    const numericValue = Number(value);
    return value.trim() !== '' && Number.isFinite(numericValue) ? numericValue : value;
  }
  if (node.type === 'boolean') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }
  return value;
};

const parseStringArrayEditValue = (value: string): string[] => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

const writeJsonPointer = (data: unknown, path: string, value: unknown): unknown => {
  if (!path.startsWith('/')) {
    return value;
  }
  const root = cloneJson(data);
  const segments = path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0) {
    return value;
  }
  const writableRoot = isWritableRecord(root) ? root : {};
  let current: Record<string, unknown> | unknown[] = writableRoot;
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) {
        throw new Error(`Invalid array path segment: ${segment}`);
      }
      if (isLast) {
        current[arrayIndex] = value;
      } else {
        current[arrayIndex] = isWritableContainer(current[arrayIndex]) ? current[arrayIndex] : nextContainer(segments[index + 1]);
        current = current[arrayIndex] as Record<string, unknown> | unknown[];
      }
    } else {
      if (isLast) {
        current[segment] = value;
      } else {
        current[segment] = isWritableContainer(current[segment]) ? current[segment] : nextContainer(segments[index + 1]);
        current = current[segment] as Record<string, unknown> | unknown[];
      }
    }
  }
  return writableRoot;
};

const cloneJson = <T,>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const isWritableRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isWritableContainer = (value: unknown): value is Record<string, unknown> | unknown[] => isWritableRecord(value) || Array.isArray(value);

const nextContainer = (nextSegment: string): Record<string, unknown> | unknown[] => (/^(0|[1-9]\d*)$/.test(nextSegment) ? [] : {});

const normalizeFeedbackDraft = (draft: FeedbackDraft, initialEditValue: string): FeedbackDraft => ({
  feedbackValue: draft.feedbackValue?.trim() ? draft.feedbackValue : undefined,
  commentValue: draft.commentValue?.trim() ? draft.commentValue : undefined,
  editValue: draft.editValue !== undefined && draft.editValue.trim() !== initialEditValue.trim() ? draft.editValue : undefined
});

const hasPendingFeedbackDrafts = (drafts: FeedbackDrafts): boolean =>
  Object.values(drafts).some((draft) => Boolean(draft.feedbackValue?.trim() || draft.commentValue?.trim() || draft.editValue !== undefined));

const removeEmptyFeedbackDrafts = (drafts: FeedbackDrafts): FeedbackDrafts =>
  Object.fromEntries(Object.entries(drafts).filter(([, draft]) => hasPendingFeedbackDrafts({ draft })));

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
    return formatDisplayValue(firstChild.value);
  }
  return firstChild.label;
};

const enumOptionValue = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
};

const formatItemCount = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'}`;

const formatValue = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
};

const formatDisplayValue = (value: unknown): string => {
  if (value === null) {
    return NOT_SET_LABEL;
  }
  const formatted = formatValue(value);
  return formatted === '' ? NOT_SET_LABEL : formatted;
};

const formatRawDisplayValue = (value: unknown): string => {
  if (value === null) {
    return NOT_SET_LABEL;
  }
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined || formatted === '' ? NOT_SET_LABEL : formatted;
};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

export { App, RenderTree };
