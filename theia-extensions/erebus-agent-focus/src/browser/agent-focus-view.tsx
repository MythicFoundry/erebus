/********************************************************************************
 * Copyright (C) 2026 Fromanium.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    ChatAgentLocation,
    ChatAgentService,
    ChatResponseModel,
    ChatService,
    InteractiveContent,
    MutableChatModel,
    QuestionResponseContent,
    ToolCallChatResponseContent
} from '@theia/ai-chat';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { ToolInvocationRegistry } from '@theia/ai-core';
import type { TheiaCoreAPI } from '@theia/core/lib/electron-common/electron-api';
import type { Disposable } from '@theia/core/lib/common/disposable';
import {
    ConversationProvider,
    ConversationSourceStatus,
    ConversationSyncService,
    SyncedConversationDetail,
    SyncedConversationSummary
} from '../common/conversation-sync-protocol';
import { WORKFLOWS } from './agent-focus-fixtures';
import { MarkdownContent, RichMarkdownEditor } from './agent-focus-markdown';
import {
    FocusContextItem,
    FocusExecutionParameters,
    FocusMessage,
    FocusAttentionRequest,
    FocusSession,
    FocusToolCall,
    SpecTask,
    SessionKind,
    SessionStatus,
    WorkflowKind
} from './agent-focus-types';

const { useEffect, useMemo, useRef, useState } = React;

const DEFAULT_RAIL_WIDTH = 290;
const MIN_RAIL_WIDTH = 220;
const MAX_RAIL_WIDTH = 520;
const RAIL_WIDTH_STORAGE_KEY = 'erebus.agentFocus.railWidth';
const PROJECT_CATEGORIES_STORAGE_KEY = 'erebus.agentFocus.projectCategories';
const PROJECTS_STORAGE_KEY = 'erebus.agentFocus.projects';
const PROJECT_TAGS_STORAGE_KEY = 'erebus.agentFocus.projectTags';
const PROJECT_SELECTED_TAGS_STORAGE_KEY = 'erebus.agentFocus.selectedProjectTags';
const CATEGORY_VIEW_STORAGE_KEY = 'erebus.agentFocus.categoryView';
const SHOW_HIDDEN_STORAGE_KEY = 'erebus.agentFocus.showHidden';
const UNCATEGORIZED_CATEGORY_ID = 'erebus-uncategorized';
const UNCATEGORIZED_CATEGORY_NAME = 'Uncategorized';
const CONVERSATION_SYNC_INTERVAL_MS = 60_000;
const SESSIONS_PER_PROJECT_PAGE = 50;
// Keep the full-screen action available for easy re-enabling, but hide it from the default toolbar.
const SHOW_FULL_SCREEN_WINDOW_CONTROL = false;
const PROJECT_HOLD_THRESHOLD_MS = 500;
const EXTERNAL_PROVIDER_ORDER: ConversationProvider[] = ['claude', 'codex', 'kiro'];
const COMPOSER_AGENT_STORAGE_KEY = 'erebus.agentFocus.composerAgent';
const COMPOSER_EFFORT_STORAGE_KEY = 'erebus.agentFocus.composerEffort';
const COMPOSER_ACCESS_STORAGE_KEY = 'erebus.agentFocus.composerAccess';
const COMPOSER_AUTOPILOT_STORAGE_KEY = 'erebus.agentFocus.composerAutopilot';
const LOCAL_SESSIONS_STORAGE_KEY = 'erebus.agentFocus.localSessions';
const SESSION_PREFERENCES_STORAGE_KEY = 'erebus.agentFocus.sessionPreferences';
const SELECTED_SESSION_STORAGE_KEY = 'erebus.agentFocus.selectedSession';
const CONTEXT_OPEN_STORAGE_KEY = 'erebus.agentFocus.contextOpen';
const CONTEXT_TAB_STORAGE_KEY = 'erebus.agentFocus.contextTab';
const RAIL_COLLAPSE_THRESHOLD = 196;
const RETIRED_DEMO_SESSION_IDS = new Set([
    'agent-focus-polish',
    'terminal-approval',
    'indexing-worker',
    'command-palette'
]);

type ComposerAgent = 'erebus' | 'explore' | 'review';
type ComposerEffort = 'quick' | 'balanced' | 'deep' | 'extra-high';
type ComposerAccess = 'ask' | 'approve' | 'full' | 'custom';
type ComposerMenu = 'context' | 'agent' | 'effort' | 'access';

interface ComposerSubmission {
    agent: ComposerAgent;
    effort: ComposerEffort;
    access: ComposerAccess;
    autopilot: boolean;
    context: FocusContextItem[];
}

interface ComposerOption<T extends string> {
    value: T;
    label: string;
    detail: string;
    icon: string;
}

const COMPOSER_AGENTS: ComposerOption<ComposerAgent>[] = [
    { value: 'erebus', label: 'Coder', detail: 'General coding and project work', icon: 'codicon-sparkle' },
    { value: 'explore', label: 'Explore', detail: 'Read-heavy investigation and codebase mapping', icon: 'codicon-search' },
    { value: 'review', label: 'Code Reviewer', detail: 'Focused change review and risk analysis', icon: 'codicon-comment-discussion' }
];

const COMPOSER_EFFORTS: ComposerOption<ComposerEffort>[] = [
    { value: 'quick', label: 'Quick', detail: 'Fast responses for small, well-defined tasks', icon: 'codicon-zap' },
    { value: 'balanced', label: 'Balanced', detail: 'A practical balance of speed and depth', icon: 'codicon-dashboard' },
    { value: 'deep', label: 'Deep', detail: 'More deliberate investigation and validation', icon: 'codicon-lightbulb' },
    { value: 'extra-high', label: 'Extra High', detail: 'Maximum reasoning for difficult work', icon: 'codicon-rocket' }
];

const COMPOSER_ACCESS_MODES: ComposerOption<ComposerAccess>[] = [
    { value: 'ask', label: 'Ask for approval', detail: 'Confirm every registered chat tool in this session', icon: 'codicon-question' },
    { value: 'approve', label: 'Approve safe tools', detail: 'Run ordinary tools and confirm tools marked sensitive', icon: 'codicon-shield' },
    { value: 'full', label: 'Allow session tools', detail: 'Allow every currently registered chat tool for this session', icon: 'codicon-unlock' },
    { value: 'custom', label: 'Configured policy', detail: 'Use the confirmation policy from Theia AI settings', icon: 'codicon-settings-gear' }
];

interface WorkflowTemplate {
    requirement: string;
    designNotes: string[];
    tasks: Array<Pick<SpecTask, 'label' | 'prompt'>>;
    starter: string;
}

const WORKFLOW_TEMPLATES: Record<WorkflowKind, WorkflowTemplate> = {
    Spec: {
        requirement: 'Turn the requested outcome into agreed requirements, a design, implementation tasks, and verified code.',
        designNotes: ['Clarify ambiguous requirements before implementation', 'Record design tradeoffs', 'Require explicit verification evidence'],
        tasks: [
            { label: 'Clarify requirements', prompt: 'Clarify the desired behavior, constraints, and acceptance criteria. Ask focused questions where evidence is missing.' },
            { label: 'Draft the design', prompt: 'Produce a concrete design from the agreed requirements, including affected components, data flow, risks, and validation.' },
            { label: 'Create the implementation plan', prompt: 'Break the design into ordered, independently verifiable implementation tasks.' },
            { label: 'Implement and verify', prompt: 'Implement the agreed design, then run proportionate validation and report the evidence.' }
        ],
        starter: 'Start this Spec workflow by helping me define the outcome and acceptance criteria.'
    },
    Plan: {
        requirement: 'Investigate the workspace and produce an evidence-backed plan without changing project files.',
        designNotes: ['Remain read-only', 'Separate confirmed facts from assumptions', 'Include risks and validation steps'],
        tasks: [
            { label: 'Map the relevant code', prompt: 'Inspect the relevant architecture and trace the current behavior without editing files.' },
            { label: 'Identify constraints and risks', prompt: 'Document constraints, dependencies, failure modes, and unresolved decisions.' },
            { label: 'Produce the execution plan', prompt: 'Produce an ordered implementation and validation plan with clear completion criteria.' }
        ],
        starter: 'Start this Plan workflow. Investigate the request read-only and build an evidence-backed execution plan.'
    },
    'Bug Fix': {
        requirement: 'Reproduce the reported failure, identify its causal path, implement the narrow repair, and verify it.',
        designNotes: ['Reproduce before changing code', 'Fix the cause instead of the symptom', 'Retest the failure boundary and adjacent behavior'],
        tasks: [
            { label: 'Reproduce the failure', prompt: 'Reproduce the failure and capture the smallest reliable failing case.' },
            { label: 'Trace the root cause', prompt: 'Trace the causal path and explain why the failure occurs before editing code.' },
            { label: 'Implement the repair', prompt: 'Implement the narrowest durable repair that addresses the confirmed cause.' },
            { label: 'Run regression checks', prompt: 'Verify the original failure and relevant adjacent behavior; report exact evidence and remaining limits.' }
        ],
        starter: 'Start this Bug Fix workflow by reproducing the problem and establishing the causal path.'
    },
    'Quick Spec': {
        requirement: 'Convert a compact request into an execution-ready brief, implement it, and verify the result.',
        designNotes: ['Keep scope intentionally small', 'Surface blockers immediately', 'Finish with concrete verification'],
        tasks: [
            { label: 'Define the brief', prompt: 'Turn the request into a concise outcome, constraints, and acceptance checks.' },
            { label: 'Implement the brief', prompt: 'Implement the accepted brief while keeping scope narrow.' },
            { label: 'Verify the result', prompt: 'Run the relevant checks and summarize the evidence.' }
        ],
        starter: 'Start this Quick Spec workflow by turning my request into a concise execution-ready brief.'
    }
};

const COMPOSER_AGENT_IDS: Record<ComposerAgent, string> = {
    erebus: 'Coder',
    explore: 'explore',
    review: 'code-reviewer'
};

const COMPOSER_REASONING_LEVELS: Record<ComposerEffort, 'minimal' | 'medium' | 'high'> = {
    quick: 'minimal',
    balanced: 'medium',
    deep: 'high',
    'extra-high': 'high'
};

interface ProjectCategory {
    id: string;
    name: string;
    projects: string[];
}

type ProjectKind = 'local' | 'remote';

interface ProjectDefinition {
    id: string;
    name: string;
    kind: ProjectKind;
    sourceFolders: string[];
    tags: string[];
    hidden: boolean;
}

interface ProjectGroup {
    project: ProjectDefinition;
    sessions: FocusSession[];
}

interface NewProjectInput {
    name: string;
    kind: ProjectKind;
    sourceFolders: string[];
}

interface NewSessionInput {
    workflow?: WorkflowKind;
    workspace: string;
}

interface SessionPreferences {
    pinned?: boolean;
    hidden?: boolean;
    tags?: string[];
}

type NavigationTarget = { kind: 'session'; sessionId: string } | { kind: 'settings' } | { kind: 'home' };

interface ActiveAgentRequest {
    chatSessionId: string;
    requestId: string;
    taskIds?: string[];
    startedAt: number;
    cancelRequested?: boolean;
}

export interface AgentFocusViewProps {
    conversationSyncService: ConversationSyncService;
    chatService: ChatService;
    chatAgentService: ChatAgentService;
    toolConfirmationManager: ToolConfirmationManager;
    toolInvocationRegistry: ToolInvocationRegistry;
    onExitFocusMode: () => void;
    onOpenFullSettings: () => void;
    onCheckForUpdates: () => Promise<unknown>;
}

const providerLabels: Record<ConversationProvider, string> = {
    claude: 'Claude',
    codex: 'Codex',
    kiro: 'Kiro'
};

const providerMonograms: Record<ConversationProvider, string> = {
    claude: 'CL',
    codex: 'CX',
    kiro: 'KI'
};

const externalProviderAccentPalette = {
    claude: '#d6ad68',
    codex: '#71b7ff',
    kiro: '#9b6cff',
    reservedNext: '#45c59a'
};

const providerAccents: Record<ConversationProvider, string> = externalProviderAccentPalette;

function relativeUpdatedAt(updatedAt: string): string {
    const elapsed = Math.max(0, Date.now() - Date.parse(updatedAt));
    if (elapsed < 60_000) {
        return 'now';
    }
    if (elapsed < 3_600_000) {
        return `${Math.floor(elapsed / 60_000)} min`;
    }
    if (elapsed < 86_400_000) {
        return `${Math.floor(elapsed / 3_600_000)} hr`;
    }
    return `${Math.floor(elapsed / 86_400_000)} d`;
}

function focusSessionFromSummary(
    summary: SyncedConversationSummary,
    storedPreferences: Record<string, SessionPreferences>,
    existing?: FocusSession
): FocusSession {
    const providerLabel = providerLabels[summary.provider];
    const sameVersion = existing?.sourceUpdatedAt === summary.updatedAt;
    const preferences = storedPreferences[`${summary.provider}:${summary.id}`];
    const session: FocusSession = {
        ...existing,
        id: `${summary.provider}:${summary.id}`,
        provider: summary.provider,
        externalId: summary.id,
        workspace: summary.workspace,
        title: summary.title,
        summary: existing?.summary
            ?? `${providerLabel} · ${summary.messageCount === undefined ? 'synced conversation' : `${summary.messageCount} messages`}`,
        updated: sameVersion && existing ? existing.updated : relativeUpdatedAt(summary.updatedAt),
        status: summary.active ? 'working' : 'paused',
        kind: 'cli',
        monogram: providerMonograms[summary.provider],
        accent: providerAccents[summary.provider],
        messages: existing?.messages ?? [],
        requirement: `Read-only conversation synchronized from ${providerLabel}'s local session store.`,
        designNotes: existing?.designNotes ?? [
            `Source remains owned by ${providerLabel}`,
            'Erebus does not modify external conversation files',
            'New turns must currently be sent from the source application'
        ],
        tasks: existing?.tasks ?? [],
        changedFiles: existing?.changedFiles ?? [],
        sourceUpdatedAt: summary.updatedAt,
        readOnly: true,
        loading: existing?.loading ?? false,
        truncatedMessages: existing?.truncatedMessages ?? 0,
        pinned: existing?.pinned ?? preferences?.pinned,
        hidden: existing?.hidden ?? preferences?.hidden,
        tags: existing?.tags ?? preferences?.tags
    };
    if (existing
        && existing.workspace === session.workspace
        && existing.title === session.title
        && existing.updated === session.updated
        && existing.status === session.status
        && existing.monogram === session.monogram
        && existing.accent === session.accent
        && existing.sourceUpdatedAt === session.sourceUpdatedAt) {
        return existing;
    }
    return session;
}

function reconcileConversationSources(
    current: ConversationSourceStatus[],
    incoming: ConversationSourceStatus[]
): ConversationSourceStatus[] {
    if (current.length === incoming.length && current.every((source, index) => {
        const next = incoming[index];
        return source.provider === next.provider
            && source.available === next.available
            && source.conversationCount === next.conversationCount
            && source.message === next.message;
    })) {
        return current;
    }
    return incoming;
}

function reconcileSyncedSessions(current: FocusSession[], summaries: SyncedConversationSummary[]): FocusSession[] {
    const local = current.filter(session => session.provider === 'erebus');
    const external = current.filter(session => session.provider !== 'erebus');
    const remaining = new Map(summaries.map(summary => [`${summary.provider}:${summary.id}`, summary]));
    const nextExternal: FocusSession[] = [];
    const storedPreferences = loadSessionPreferences();

    external.forEach(session => {
        const summary = remaining.get(session.id);
        if (summary) {
            nextExternal.push(focusSessionFromSummary(summary, storedPreferences, session));
            remaining.delete(session.id);
        }
    });
    summaries.forEach(summary => {
        const id = `${summary.provider}:${summary.id}`;
        if (remaining.has(id)) {
            nextExternal.push(focusSessionFromSummary(summary, storedPreferences));
            remaining.delete(id);
        }
    });

    const next = [...local, ...nextExternal];
    return next.length === current.length && next.every((session, index) => session === current[index])
        ? current
        : next;
}

function sameSyncedMessage(left: FocusMessage, right: FocusMessage): boolean {
    return left.id === right.id
        && left.role === right.role
        && left.toolCalls === right.toolCalls
        && left.body.length === right.body.length
        && left.body.every((part, index) => part === right.body[index]);
}

function reconcileSyncedMessages(current: FocusMessage[], incoming: FocusMessage[]): FocusMessage[] {
    if (incoming.length >= current.length && current.every((message, index) => sameSyncedMessage(message, incoming[index]))) {
        return incoming.length === current.length ? current : [...current, ...incoming.slice(current.length)];
    }
    return incoming;
}

function applyConversationDetail(session: FocusSession, detail: SyncedConversationDetail): FocusSession {
    const messages = reconcileSyncedMessages(session.messages, detail.messages);
    const summary = `${providerLabels[detail.provider]} · ${detail.messages.length + detail.truncatedMessages} messages`;
    const status = detail.active ? 'working' : 'paused';
    if (messages === session.messages
        && summary === session.summary
        && detail.updatedAt === session.sourceUpdatedAt
        && status === session.status
        && !session.loading
        && detail.truncatedMessages === session.truncatedMessages) {
        return session;
    }
    return {
        ...session,
        messages,
        summary,
        sourceUpdatedAt: detail.updatedAt,
        status,
        loading: false,
        truncatedMessages: detail.truncatedMessages
    };
}

const statusLabels: Record<SessionStatus, string> = {
    working: 'Working',
    attention: 'Needs attention',
    paused: 'Paused',
    complete: 'Complete'
};

const kindIcons: Record<SessionKind, string> = {
    local: 'codicon-device-desktop',
    cloud: 'codicon-cloud',
    cli: 'codicon-terminal'
};

function Icon({ name, className = '' }: { name: string; className?: string }): React.ReactElement {
    return <i aria-hidden='true' className={`codicon ${name} ${className}`} />;
}

function StatusDot({ status }: { status: SessionStatus }): React.ReactElement {
    return <span className={`erebus-status-dot is-${status}`} title={statusLabels[status]} aria-label={statusLabels[status]} />;
}

function AgentMark({ small = false }: { small?: boolean }): React.ReactElement {
    return <span className={`erebus-agent-mark${small ? ' is-small' : ''}`} aria-hidden='true'>
        <span />
        <span />
    </span>;
}

function useDialogFocus<T extends HTMLElement>(onClose: () => void): React.MutableRefObject<T | undefined> {
    const dialogRef = useRef<T | undefined>(undefined);
    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const animationFrame = window.requestAnimationFrame(() => {
            const dialog = dialogRef.current;
            const initial = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
                ?? dialog?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button, [tabindex]:not([tabindex="-1"])');
            initial?.focus({ preventScroll: true });
        });
        const handleKeyDown = (event: KeyboardEvent): void => {
            const dialog = dialogRef.current;
            if (!dialog) {
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab') {
                return;
            }
            const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
            )).filter(element => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus({ preventScroll: true });
                return;
            }
            const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && currentIndex <= 0) {
                event.preventDefault();
                focusable[focusable.length - 1].focus();
            } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
                event.preventDefault();
                focusable[0].focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.cancelAnimationFrame(animationFrame);
            document.removeEventListener('keydown', handleKeyDown, true);
            if (previousFocus?.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, [onClose]);
    return dialogRef;
}

function clampRailWidth(width: number): number {
    return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, width));
}

function loadRailWidth(): number {
    try {
        const storedWidth = Number(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY));
        return Number.isFinite(storedWidth) && storedWidth > 0 ? clampRailWidth(storedWidth) : DEFAULT_RAIL_WIDTH;
    } catch {
        return DEFAULT_RAIL_WIDTH;
    }
}

function loadProjectCategories(): ProjectCategory[] {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(PROJECT_CATEGORIES_STORAGE_KEY) ?? '[]');
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap(candidate => {
            if (!candidate || typeof candidate !== 'object') {
                return [];
            }
            const record = candidate as Record<string, unknown>;
            if (typeof record.id !== 'string' || typeof record.name !== 'string' || !Array.isArray(record.projects)) {
                return [];
            }
            return [{
                id: record.id,
                name: record.name,
                projects: record.projects.filter((project): project is string => typeof project === 'string')
            }];
        }).filter(category => category.id !== UNCATEGORIZED_CATEGORY_ID
            && category.name.toLocaleLowerCase() !== UNCATEGORIZED_CATEGORY_NAME.toLocaleLowerCase());
    } catch {
        return [];
    }
}

function loadProjects(): ProjectDefinition[] {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(PROJECTS_STORAGE_KEY) ?? '[]');
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap(candidate => {
            if (!candidate || typeof candidate !== 'object') {
                return [];
            }
            const record = candidate as Record<string, unknown>;
            if (typeof record.id !== 'string' || typeof record.name !== 'string'
                || (record.kind !== 'local' && record.kind !== 'remote') || !Array.isArray(record.sourceFolders)) {
                return [];
            }
            return [{
                id: record.id,
                name: record.name,
                kind: record.kind,
                sourceFolders: record.sourceFolders.filter((folder): folder is string => typeof folder === 'string'),
                tags: Array.isArray(record.tags)
                    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
                    : [],
                hidden: record.hidden === true
            }];
        });
    } catch {
        return [];
    }
}

function loadStoredStringList(storageKey: string): string[] {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
        return [];
    }
}

function loadStoredBoolean(storageKey: string, fallback: boolean): boolean {
    try {
        const stored = window.localStorage.getItem(storageKey);
        return typeof stored === 'string' ? stored === 'true' : fallback;
    } catch {
        return fallback;
    }
}

function loadComposerPreference<T extends string>(
    storageKey: string,
    options: ReadonlyArray<ComposerOption<T>>,
    fallback: T
): T {
    try {
        const stored = window.localStorage.getItem(storageKey);
        return options.some(option => option.value === stored) ? stored as T : fallback;
    } catch {
        return fallback;
    }
}

function loadComposerAutopilot(): boolean {
    try {
        return window.localStorage.getItem(COMPOSER_AUTOPILOT_STORAGE_KEY) !== 'false';
    } catch {
        return true;
    }
}

function storeComposerPreference(storageKey: string, value: string | boolean): void {
    try {
        window.localStorage.setItem(storageKey, String(value));
    } catch {
        // Persistence is optional in restricted browser contexts.
    }
}

function loadSessionPreferences(): Record<string, SessionPreferences> {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(SESSION_PREFERENCES_STORAGE_KEY) ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return [];
            }
            const candidate = value as Record<string, unknown>;
            return [[id, {
                pinned: candidate.pinned === true,
                hidden: candidate.hidden === true,
                tags: Array.isArray(candidate.tags)
                    ? candidate.tags.filter((tag): tag is string => typeof tag === 'string')
                    : []
            }]];
        }));
    } catch {
        return {};
    }
}

function storedStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeStoredMessage(value: unknown): FocusMessage | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || (record.role !== 'user' && record.role !== 'agent') || !Array.isArray(record.body)) {
        return undefined;
    }
    const toolDetails = Array.isArray(record.toolDetails) ? record.toolDetails.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return [];
        }
        const detail = candidate as Record<string, unknown>;
        if (typeof detail.id !== 'string' || typeof detail.name !== 'string'
            || (detail.status !== 'approval' && detail.status !== 'running' && detail.status !== 'complete')) {
            return [];
        }
        return [{
            id: detail.id,
            name: detail.name,
            status: detail.status,
            detail: typeof detail.detail === 'string' ? detail.detail : undefined
        } as FocusToolCall];
    }) : undefined;
    return {
        id: record.id,
        role: record.role,
        body: storedStringArray(record.body),
        agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
        executionProfile: typeof record.executionProfile === 'string' ? record.executionProfile : undefined,
        toolCalls: typeof record.toolCalls === 'number' && Number.isFinite(record.toolCalls) ? record.toolCalls : undefined,
        toolDetails,
        changedFiles: storedStringArray(record.changedFiles),
        elapsed: typeof record.elapsed === 'string' ? record.elapsed : undefined
    };
}

function normalizeStoredSession(value: unknown): FocusSession | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.provider !== 'erebus' || typeof record.id !== 'string'
        || typeof record.workspace !== 'string' || typeof record.title !== 'string') {
        return undefined;
    }
    const tasks = Array.isArray(record.tasks) ? record.tasks.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return [];
        }
        const task = candidate as Record<string, unknown>;
        if (typeof task.id !== 'string' || typeof task.label !== 'string') {
            return [];
        }
        return [{
            id: task.id,
            label: task.label,
            complete: task.complete === true,
            prompt: typeof task.prompt === 'string' ? task.prompt : undefined,
            awaitingReview: task.awaitingReview === true
        }];
    }) : [];
    const messages = Array.isArray(record.messages)
        ? record.messages.map(normalizeStoredMessage).filter((message): message is FocusMessage => Boolean(message))
        : [];
    const status: SessionStatus = record.status === 'working' || record.status === 'complete' || record.status === 'paused'
        ? record.status : 'paused';
    const kind: SessionKind = record.kind === 'cloud' || record.kind === 'cli' ? record.kind : 'local';
    const workflow = record.workflow === 'Spec' || record.workflow === 'Plan'
        || record.workflow === 'Bug Fix' || record.workflow === 'Quick Spec' ? record.workflow : undefined;
    return {
        id: record.id,
        provider: 'erebus',
        workspace: record.workspace,
        title: record.title,
        summary: typeof record.summary === 'string' ? record.summary : 'Ready for a new direction',
        updated: typeof record.updated === 'string' ? record.updated : 'now',
        status,
        kind,
        monogram: typeof record.monogram === 'string' ? record.monogram.slice(0, 2) : 'AF',
        accent: typeof record.accent === 'string' ? record.accent : '#9b6cff',
        messages,
        requirement: typeof record.requirement === 'string' ? record.requirement : 'Describe the outcome you want the agent to own.',
        designNotes: storedStringArray(record.designNotes),
        tasks,
        changedFiles: storedStringArray(record.changedFiles),
        chatSessionId: typeof record.chatSessionId === 'string' ? record.chatSessionId : undefined,
        pinned: record.pinned === true,
        hidden: record.hidden === true,
        tags: storedStringArray(record.tags),
        changeReviews: record.changeReviews && typeof record.changeReviews === 'object' && !Array.isArray(record.changeReviews)
            ? Object.fromEntries(Object.entries(record.changeReviews as Record<string, unknown>)
                .filter((entry): entry is [string, 'pending' | 'accepted' | 'rejected'] =>
                    entry[1] === 'pending' || entry[1] === 'accepted' || entry[1] === 'rejected'))
            : undefined,
        workflow
    };
}

function loadLocalSessions(): FocusSession[] {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(LOCAL_SESSIONS_STORAGE_KEY) ?? '[]');
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.map(normalizeStoredSession).filter((session): session is FocusSession =>
            session !== undefined && !RETIRED_DEMO_SESSION_IDS.has(session.id));
    } catch {
        return [];
    }
}

function loadSelectedSessionId(sessions: FocusSession[]): string | undefined {
    try {
        const stored = window.localStorage.getItem(SELECTED_SESSION_STORAGE_KEY);
        return stored && sessions.some(session => session.id === stored) ? stored : sessions[0]?.id;
    } catch {
        return sessions[0]?.id;
    }
}

function storeJson(storageKey: string, value: unknown): void {
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
        // Persistence is optional in restricted browser contexts.
    }
}

function getElectronWindowApi(): TheiaCoreAPI | undefined {
    return 'electronTheiaCore' in window ? window.electronTheiaCore : undefined;
}

function pathForAttachedFile(file: File): string {
    try {
        return getElectronWindowApi()?.getPathForFile(file) || file.webkitRelativePath || file.name;
    } catch {
        return file.webkitRelativePath || file.name;
    }
}

function folderSelectionFromFiles(files: File[]): { name: string; path: string } | undefined {
    const firstFile = files[0];
    if (!firstFile) {
        return undefined;
    }
    const absolutePath = pathForAttachedFile(firstFile);
    const relativePath = firstFile.webkitRelativePath;
    const relativeRoot = relativePath.split('/')[0];
    if (relativeRoot && relativePath) {
        const separator = absolutePath.includes('\\') ? '\\' : '/';
        const normalizedRelativePath = relativePath.replace(/[\\/]/g, separator);
        if (absolutePath.toLocaleLowerCase().endsWith(normalizedRelativePath.toLocaleLowerCase())) {
            return {
                name: relativeRoot,
                path: `${absolutePath.slice(0, -normalizedRelativePath.length)}${relativeRoot}`
            };
        }
        return { name: relativeRoot, path: relativeRoot };
    }
    const pathParts = absolutePath.split(/[\\/]/).filter(Boolean);
    const fallbackName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : pathParts[0] || 'Project';
    const lastSeparator = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'));
    return {
        name: fallbackName,
        path: lastSeparator > 0 ? absolutePath.slice(0, lastSeparator) : absolutePath
    };
}

function hasSelectedTag(tags: readonly string[], selectedTags: ReadonlySet<string>): boolean {
    return selectedTags.size === 0 || tags.some(tag => selectedTags.has(tag));
}

function matchesSearchQuery(query: string, values: ReadonlyArray<string | undefined>): boolean {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
        return true;
    }
    const searchableText = values.filter((value): value is string => Boolean(value)).join('\n').toLocaleLowerCase();
    return terms.every(term => searchableText.includes(term));
}

function sessionMatchesSearch(session: FocusSession, query: string): boolean {
    return matchesSearchQuery(query, [
        session.title,
        session.summary,
        session.workspace,
        session.provider,
        ...session.tags ?? []
    ]);
}

function toggleElectronWindowMaximized(): void {
    const electronApi = getElectronWindowApi();
    if (!electronApi) {
        return;
    }
    if (electronApi.isMaximized()) {
        electronApi.unMaximize();
    } else {
        electronApi.maximize();
    }
}

function WindowControls(): React.ReactElement {
    const electronApi = getElectronWindowApi();
    const [maximized, setMaximized] = useState(() => electronApi?.isMaximized() ?? false);
    const [fullScreen, setFullScreen] = useState(() => electronApi?.isFullScreen() ?? false);

    useEffect(() => {
        if (!electronApi) {
            return undefined;
        }

        const syncWindowState = (): void => {
            setMaximized(electronApi.isMaximized());
            setFullScreen(electronApi.isFullScreen());
        };
        const disposables = [
            electronApi.onWindowEvent('maximize', syncWindowState),
            electronApi.onWindowEvent('unmaximize', syncWindowState),
            electronApi.onWindowEvent('focus', syncWindowState)
        ];
        syncWindowState();
        return () => disposables.forEach(disposable => disposable.dispose());
    }, [electronApi]);

    if (!electronApi) {
        return <></>;
    }

    const toggleMaximized = (): void => {
        const nextMaximized = !electronApi.isMaximized();
        toggleElectronWindowMaximized();
        setMaximized(nextMaximized);
    };
    const toggleFullScreen = (): void => {
        electronApi.toggleFullScreen();
        setFullScreen(value => !value);
    };

    return <div className='erebus-window-controls' aria-label='Window controls'>
        <button type='button' className='erebus-window-control' onClick={() => electronApi.minimize()}
            aria-label='Minimize Erebus' title='Minimize'>
            <Icon name='codicon-chrome-minimize' />
        </button>
        <button type='button' className='erebus-window-control' onClick={toggleMaximized}
            aria-label={maximized ? 'Restore Erebus window' : 'Maximize Erebus'} title={maximized ? 'Restore' : 'Maximize'}>
            <Icon name={maximized ? 'codicon-chrome-restore' : 'codicon-chrome-maximize'} />
        </button>
        {SHOW_FULL_SCREEN_WINDOW_CONTROL && <button type='button' className='erebus-window-control' onClick={toggleFullScreen}
            aria-label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={fullScreen ? 'Exit full screen' : 'Full screen'}>
            <Icon name={fullScreen ? 'codicon-screen-normal' : 'codicon-screen-full'} />
        </button>}
        <button type='button' className='erebus-window-control is-close' onClick={() => electronApi.close()}
            aria-label='Close Erebus' title='Close Erebus'>
            <Icon name='codicon-chrome-close' />
        </button>
    </div>;
}

function SessionRow({ session, active, collapsed, onSelect, onTogglePin, onRename, onToggleHidden, onRemove }: {
    session: FocusSession;
    active: boolean;
    collapsed: boolean;
    onSelect: () => void;
    onTogglePin: () => void;
    onRename: () => void;
    onToggleHidden: () => void;
    onRemove: () => void;
}): React.ReactElement {
    const [menuOpen, setMenuOpen] = useState(false);
    const rowRef = useRef<HTMLDivElement | undefined>(undefined);

    useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }
        const close = (event: PointerEvent): void => {
            if (!rowRef.current?.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setMenuOpen(false);
            }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [menuOpen]);

    if (collapsed) {
        return <button
            type='button'
            className={`erebus-session-tile${active ? ' is-active' : ''}`}
            onClick={onSelect}
            title={`${session.title} — ${statusLabels[session.status]}`}
            aria-label={`${session.title}, ${statusLabels[session.status]}`}
        >
            <span className='erebus-session-monogram' style={{ '--session-accent': session.accent } as React.CSSProperties}>
                {session.monogram}
            </span>
            <StatusDot status={session.status} />
            <Icon name={kindIcons[session.kind]} className='erebus-session-kind' />
            {session.pinned && <Icon name='codicon-pin' className='erebus-session-pin' />}
        </button>;
    }

    return <div ref={element => rowRef.current = element ?? undefined}
        className={`erebus-session-row-shell${active ? ' is-active' : ''}${menuOpen ? ' has-menu' : ''}`}>
        <button type='button' className='erebus-session-row' onClick={onSelect} aria-current={active ? 'page' : undefined}>
            <span className='erebus-session-row-topline'>
                <span className='erebus-session-title'>
                    <StatusDot status={session.status} />
                    {session.pinned && <Icon name='codicon-pin' className='erebus-inline-pin' />}
                    {session.title}
                </span>
                <span className='erebus-session-time'>{session.updated}</span>
            </span>
            <span className='erebus-session-summary'>{session.summary}</span>
            <span className='erebus-session-meta'>
                <Icon name={kindIcons[session.kind]} />
                {session.kind}
            </span>
        </button>
        <button type='button' className='erebus-session-menu-button' aria-label={`Manage ${session.title}`}
            title='Session actions' aria-haspopup='menu' aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}><Icon name='codicon-ellipsis' /></button>
        {menuOpen && <div className='erebus-session-menu' role='menu' aria-label={`${session.title} actions`}>
            <button type='button' role='menuitem' onClick={() => { onTogglePin(); setMenuOpen(false); }}>
                <Icon name={session.pinned ? 'codicon-pinned-dirty' : 'codicon-pin'} />{session.pinned ? 'Unpin session' : 'Pin session'}
            </button>
            {session.provider === 'erebus' && <button type='button' role='menuitem' onClick={() => { onRename(); setMenuOpen(false); }}>
                <Icon name='codicon-edit' />Rename
            </button>}
            <button type='button' role='menuitem' onClick={() => { onToggleHidden(); setMenuOpen(false); }}>
                <Icon name={session.hidden ? 'codicon-eye' : 'codicon-eye-closed'} />{session.hidden ? 'Show in rail' : 'Hide from rail'}
            </button>
            {session.provider === 'erebus' && <button type='button' role='menuitem' className='is-danger'
                onClick={() => { onRemove(); setMenuOpen(false); }}>
                <Icon name='codicon-trash' />Remove session
            </button>}
        </div>}
    </div>;
}

function RailToolbar({
    searchQuery,
    categoryView,
    showHidden,
    tags,
    selectedTags,
    onSearchQueryChange,
    onToggleCategoryView,
    onToggleShowHidden,
    onSelectAllTags,
    onToggleTag,
    onCreateTag
}: {
    searchQuery: string;
    categoryView: boolean;
    showHidden: boolean;
    tags: string[];
    selectedTags: ReadonlySet<string>;
    onSearchQueryChange: (query: string) => void;
    onToggleCategoryView: () => void;
    onToggleShowHidden: () => void;
    onSelectAllTags: () => void;
    onToggleTag: (tag: string) => void;
    onCreateTag: (tag: string) => void;
}): React.ReactElement {
    const [searchOpen, setSearchOpen] = useState(false);
    const [tagMenuOpen, setTagMenuOpen] = useState(false);
    const [newTagName, setNewTagName] = useState('');
    const toolbarRef = useRef<HTMLDivElement | undefined>(undefined);
    const searchInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const trimmedTagName = newTagName.trim();
    const duplicateTag = tags.some(tag => tag.toLocaleLowerCase() === trimmedTagName.toLocaleLowerCase());

    useEffect(() => {
        if (!tagMenuOpen) {
            return undefined;
        }
        const closeOnPointerDown = (event: PointerEvent): void => {
            if (!toolbarRef.current?.contains(event.target as Node)) {
                setTagMenuOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setTagMenuOpen(false);
            }
        };
        window.addEventListener('pointerdown', closeOnPointerDown);
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            window.removeEventListener('pointerdown', closeOnPointerDown);
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [tagMenuOpen]);

    useEffect(() => {
        if (searchOpen) {
            searchInputRef.current?.focus();
        }
    }, [searchOpen]);

    const createTag = (): void => {
        if (!trimmedTagName || duplicateTag) {
            return;
        }
        onCreateTag(trimmedTagName);
        setNewTagName('');
    };

    const closeSearch = (): void => {
        onSearchQueryChange('');
        setSearchOpen(false);
    };

    return <div ref={element => toolbarRef.current = element ?? undefined} className='erebus-rail-toolbar-shell'>
        <div className='erebus-rail-toolbar' aria-label='Project view controls'>
            <button type='button' className={`erebus-rail-search-toggle${searchOpen ? ' is-active' : ''}`}
                aria-expanded={searchOpen} aria-controls='erebus-rail-search' aria-label='Search projects and conversations'
                title='Search projects and conversations' onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>
                <Icon name='codicon-search' />
            </button>
            <button type='button' className={categoryView ? 'is-active' : ''} aria-pressed={categoryView}
                onClick={onToggleCategoryView} aria-label='Category view mode' title={`Category view ${categoryView ? 'on' : 'off'}`}>
                <Icon name={categoryView ? 'codicon-folder-active' : 'codicon-folder'} />
            </button>
            <button type='button' className={showHidden ? 'is-active' : ''} aria-pressed={showHidden}
                onClick={onToggleShowHidden} aria-label='Show hidden conversations and projects'
                title={`Show hidden conversations and projects ${showHidden ? 'on' : 'off'}`}>
                <Icon name={showHidden ? 'codicon-eye' : 'codicon-eye-closed'} />
            </button>
            <span className='erebus-rail-tag-shell'>
                <button type='button' className={selectedTags.size > 0 || tagMenuOpen ? 'is-active' : ''}
                    aria-haspopup='dialog' aria-expanded={tagMenuOpen} onClick={() => setTagMenuOpen(open => !open)}
                    aria-label='Filter projects and conversations by tag' title='Filter by tag'>
                    <Icon name='codicon-tag' />
                    {selectedTags.size > 0 && <span className='erebus-rail-filter-count'>{selectedTags.size}</span>}
                </button>
                {tagMenuOpen && <div className='erebus-tag-filter-menu' role='dialog' aria-label='Tag filters'>
                    <header>Tags</header>
                    <label className='erebus-tag-filter-option'>
                        <input type='checkbox' checked={selectedTags.size === 0} onChange={onSelectAllTags} />
                        <span>All</span>
                    </label>
                    {tags.map(tag => <label className='erebus-tag-filter-option' key={tag}>
                        <input type='checkbox' checked={selectedTags.has(tag)} onChange={() => onToggleTag(tag)} />
                        <span>{tag}</span>
                    </label>)}
                    {tags.length === 0 && <span className='erebus-tag-filter-empty'>No tags yet</span>}
                    <form className='erebus-tag-create-row' onSubmit={event => {
                        event.preventDefault();
                        createTag();
                    }}>
                        <input value={newTagName} onChange={event => setNewTagName(event.currentTarget.value)}
                            placeholder='Create a tag' aria-label='New tag name' aria-invalid={duplicateTag || undefined} />
                        <button type='submit' disabled={!trimmedTagName || duplicateTag} aria-label='Create tag' title='Create tag'>
                            <Icon name='codicon-add' />
                        </button>
                    </form>
                    {duplicateTag && <span className='erebus-tag-filter-error'>That tag already exists.</span>}
                </div>}
            </span>
        </div>
        {searchOpen && <div id='erebus-rail-search' className='erebus-rail-search' role='search'>
            <Icon name='codicon-search' />
            <input ref={element => searchInputRef.current = element ?? undefined} type='search' value={searchQuery}
                onChange={event => onSearchQueryChange(event.currentTarget.value)} placeholder='Search projects and conversations'
                aria-label='Search projects and conversations' onKeyDown={event => {
                    if (event.key === 'Escape') {
                        closeSearch();
                    }
                }} />
            {searchQuery && <button type='button' onClick={() => onSearchQueryChange('')} aria-label='Clear search' title='Clear search'>
                <Icon name='codicon-close' />
            </button>}
        </div>}
    </div>;
}

function SessionRail({ sessions, projects, categories, sources, selectedId, collapsed, onSelect, onNewSession, onNewProject, onCreateCategory,
    onAssignProject, onTogglePin, onRenameSession, onToggleHidden, onRemoveSession, onOpenSettings }: {
    sessions: FocusSession[];
    projects: ProjectDefinition[];
    categories: ProjectCategory[];
    sources: ConversationSourceStatus[];
    selectedId?: string;
    collapsed: boolean;
    onSelect: (id: string) => void;
    onNewSession: () => void;
    onNewProject: () => void;
    onCreateCategory: (project?: string) => void;
    onAssignProject: (categoryId: string, project: string) => void;
    onTogglePin: (id: string) => void;
    onRenameSession: (id: string) => void;
    onToggleHidden: (id: string) => void;
    onRemoveSession: (id: string) => void;
    onOpenSettings: () => void;
}): React.ReactElement {
    const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
    const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<string>>(() => new Set());
    const [collapsedProviders, setCollapsedProviders] = useState<ReadonlySet<ConversationProvider>>(
        () => new Set(EXTERNAL_PROVIDER_ORDER)
    );
    const [categoryView, setCategoryView] = useState(() => loadStoredBoolean(CATEGORY_VIEW_STORAGE_KEY, true));
    const [showHidden, setShowHidden] = useState(() => loadStoredBoolean(SHOW_HIDDEN_STORAGE_KEY, true));
    const [searchQuery, setSearchQuery] = useState('');
    const [definedTags, setDefinedTags] = useState(() => loadStoredStringList(PROJECT_TAGS_STORAGE_KEY));
    const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
        () => new Set(loadStoredStringList(PROJECT_SELECTED_TAGS_STORAGE_KEY))
    );
    const [visibleSessionLimits, setVisibleSessionLimits] = useState<Record<string, number>>({});
    const [draggedProject, setDraggedProject] = useState<string | undefined>();
    const [dropCategoryId, setDropCategoryId] = useState<string | undefined>();
    const initializedExternalProjects = useRef(new Set<string>());
    const projectDragCleanupRef = useRef<(() => void) | undefined>();
    const suppressedProjectClickRef = useRef<string | undefined>();
    const searching = searchQuery.trim().length > 0;

    const availableTags = useMemo(() => {
        const result = new Map<string, string>();
        [...definedTags, ...projects.flatMap(project => project.tags), ...sessions.flatMap(session => session.tags ?? [])]
            .forEach(tag => {
                const trimmedTag = tag.trim();
                if (trimmedTag && !result.has(trimmedTag.toLocaleLowerCase())) {
                    result.set(trimmedTag.toLocaleLowerCase(), trimmedTag);
                }
            });
        return [...result.values()];
    }, [definedTags, projects, sessions]);

    const groups = useMemo<ProjectGroup[]>(() => {
        const sessionGroups = new Map<string, FocusSession[]>();
        sessions.filter(session => session.provider === 'erebus').forEach(session => {
            const group = sessionGroups.get(session.workspace) ?? [];
            group.push(session);
            sessionGroups.set(session.workspace, group);
        });
        const projectDefinitions = new Map(projects.map(project => [project.name.toLocaleLowerCase(), project]));
        const orderedProjectNames = [
            ...sessionGroups.keys(),
            ...projects.map(project => project.name).filter(name => !sessionGroups.has(name))
        ];
        return orderedProjectNames.flatMap(name => {
            const workspaceSessions = sessionGroups.get(name) ?? [];
            const definition = projectDefinitions.get(name.toLocaleLowerCase());
            const projectTags = definition?.tags ?? Array.from(new Set(workspaceSessions.flatMap(session => session.tags ?? [])));
            const project: ProjectDefinition = definition ?? {
                id: `session-project-${encodeURIComponent(name)}`,
                name,
                kind: workspaceSessions.some(session => session.kind === 'cloud') ? 'remote' : 'local',
                sourceFolders: [],
                tags: projectTags,
                hidden: workspaceSessions.length > 0 && workspaceSessions.every(session => session.hidden === true)
            };
            if (!showHidden && project.hidden) {
                return [];
            }
            const projectMatchesTags = hasSelectedTag(project.tags, selectedTags);
            const projectMatchesSearch = matchesSearchQuery(searchQuery, [
                project.name,
                project.kind,
                ...project.sourceFolders,
                ...project.tags
            ]);
            const visibleSessions = workspaceSessions.filter(session => (showHidden || !session.hidden)
                && (projectMatchesTags || hasSelectedTag(session.tags ?? [], selectedTags))
                && (projectMatchesSearch || sessionMatchesSearch(session, searchQuery)));
            if (selectedTags.size > 0 && !projectMatchesTags && visibleSessions.length === 0) {
                return [];
            }
            if (searching && !projectMatchesSearch && visibleSessions.length === 0) {
                return [];
            }
            return [{ project, sessions: visibleSessions }];
        });
    }, [projects, searchQuery, searching, selectedTags, sessions, showHidden]);
    const externalGroups = useMemo(() => {
        const result = new Map<ConversationProvider, Map<string, FocusSession[]>>();
        EXTERNAL_PROVIDER_ORDER.forEach(provider => result.set(provider, new Map()));
        sessions.filter(session => session.provider !== 'erebus'
            && (showHidden || !session.hidden)
            && hasSelectedTag(session.tags ?? [], selectedTags)
            && matchesSearchQuery(searchQuery, [
                session.provider,
                providerLabels[session.provider as ConversationProvider],
                session.workspace,
                session.title,
                session.summary,
                ...session.tags ?? []
            ])).forEach(session => {
            const provider = session.provider as ConversationProvider;
            const providerGroups = result.get(provider) ?? new Map<string, FocusSession[]>();
            const workspaceSessions = providerGroups.get(session.workspace) ?? [];
            workspaceSessions.push(session);
            providerGroups.set(session.workspace, workspaceSessions);
            result.set(provider, providerGroups);
        });
        return result;
    }, [searchQuery, selectedTags, sessions, showHidden]);
    const categorizedProjects = useMemo(() => new Set(categories.flatMap(category => category.projects)), [categories]);
    const uncategorizedProjects = groups.filter(group => !categorizedProjects.has(group.project.name));

    useEffect(() => {
        try {
            window.localStorage.setItem(CATEGORY_VIEW_STORAGE_KEY, String(categoryView));
            window.localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, String(showHidden));
            window.localStorage.setItem(PROJECT_TAGS_STORAGE_KEY, JSON.stringify(definedTags));
            window.localStorage.setItem(PROJECT_SELECTED_TAGS_STORAGE_KEY, JSON.stringify([...selectedTags]));
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [categoryView, definedTags, selectedTags, showHidden]);

    useEffect(() => {
        const newProjectKeys: string[] = [];
        externalGroups.forEach((providerProjects, provider) => providerProjects.forEach((_sessions, workspace) => {
            const key = `${provider}:${workspace}`;
            if (!initializedExternalProjects.current.has(key)) {
                initializedExternalProjects.current.add(key);
                newProjectKeys.push(key);
            }
        }));
        if (newProjectKeys.length > 0) {
            setCollapsedProjects(current => new Set([...current, ...newProjectKeys]));
        }
    }, [externalGroups]);

    const toggleSelectedTag = (tag: string): void => {
        setSelectedTags(current => {
            const next = new Set(current);
            if (next.has(tag)) {
                next.delete(tag);
            } else {
                next.add(tag);
            }
            return next;
        });
    };

    const createTag = (tag: string): void => {
        setDefinedTags(current => current.some(candidate => candidate.toLocaleLowerCase() === tag.toLocaleLowerCase())
            ? current
            : [...current, tag]);
    };

    const toggleProject = (workspace: string): void => {
        setCollapsedProjects(current => {
            const next = new Set(current);
            if (next.has(workspace)) {
                next.delete(workspace);
            } else {
                next.add(workspace);
            }
            return next;
        });
    };

    const toggleCategory = (categoryId: string): void => {
        setCollapsedCategories(current => {
            const next = new Set(current);
            if (next.has(categoryId)) {
                next.delete(categoryId);
            } else {
                next.add(categoryId);
            }
            return next;
        });
    };

    const toggleProvider = (provider: ConversationProvider): void => {
        setCollapsedProviders(current => {
            const next = new Set(current);
            if (next.has(provider)) {
                next.delete(provider);
            } else {
                next.add(provider);
            }
            return next;
        });
    };

    const endProjectDrag = (): void => {
        setDraggedProject(undefined);
        setDropCategoryId(undefined);
    };

    useEffect(() => () => projectDragCleanupRef.current?.(), []);

    const beginProjectInteraction = (
        event: React.PointerEvent<HTMLElement>,
        workspace: string,
        projectKey: string,
        draggable: boolean
    ): void => {
        if (event.button !== 0) {
            return;
        }
        projectDragCleanupRef.current?.();
        suppressedProjectClickRef.current = undefined;
        const startX = event.clientX;
        const startY = event.clientY;
        const startedAt = event.timeStamp;
        let started = false;

        const categoryAtPoint = (x: number, y: number): string | undefined =>
            document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-category-id]')?.dataset.categoryId;
        const cleanup = (): void => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', drop);
            window.removeEventListener('pointercancel', cancel);
            projectDragCleanupRef.current = undefined;
        };
        const move = (moveEvent: PointerEvent): void => {
            if (draggable && !started && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= 5) {
                started = true;
                setDraggedProject(workspace);
            }
            if (started) {
                moveEvent.preventDefault();
                setDropCategoryId(categoryAtPoint(moveEvent.clientX, moveEvent.clientY));
            }
        };
        const drop = (dropEvent: PointerEvent): void => {
            cleanup();
            if (started || dropEvent.timeStamp - startedAt >= PROJECT_HOLD_THRESHOLD_MS) {
                suppressedProjectClickRef.current = projectKey;
            }
            if (started) {
                const categoryId = categoryAtPoint(dropEvent.clientX, dropEvent.clientY);
                if (categoryId) {
                    onAssignProject(categoryId, workspace);
                } else if (document.elementFromPoint(dropEvent.clientX, dropEvent.clientY)?.closest('[data-new-category]')) {
                    onCreateCategory(workspace);
                }
            }
            endProjectDrag();
        };
        const cancel = (): void => {
            cleanup();
            suppressedProjectClickRef.current = projectKey;
            endProjectDrag();
        };

        projectDragCleanupRef.current = cleanup;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', drop);
        window.addEventListener('pointercancel', cancel);
    };

    const clickProject = (event: React.MouseEvent<HTMLButtonElement>, projectKey: string): void => {
        if (event.detail !== 0 && suppressedProjectClickRef.current === projectKey) {
            suppressedProjectClickRef.current = undefined;
            return;
        }
        suppressedProjectClickRef.current = undefined;
        toggleProject(projectKey);
    };

    const renderProject = (
        group: ProjectGroup,
        categoryName?: string,
        provider: 'erebus' | ConversationProvider = 'erebus'
    ): React.ReactElement => {
        const workspace = group.project.name;
        const workspaceSessions = group.sessions;
        const orderedWorkspaceSessions = [...workspaceSessions].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
        const projectKey = `${provider}:${workspace}`;
        const visibleLimit = visibleSessionLimits[projectKey] ?? SESSIONS_PER_PROJECT_PAGE;
        const initialVisibleSessions = orderedWorkspaceSessions.slice(0, visibleLimit);
        const selectedOutsidePage = selectedId
            ? orderedWorkspaceSessions.find(session => session.id === selectedId && !initialVisibleSessions.some(candidate => candidate.id === session.id))
            : undefined;
        const visibleSessions = selectedOutsidePage && visibleLimit > 0
            ? [...initialVisibleSessions.slice(0, visibleLimit - 1), selectedOutsidePage]
            : initialVisibleSessions;
        const projectCollapsed = !searching && collapsedProjects.has(projectKey);
        const projectSessionsId = `erebus-project-sessions-${encodeURIComponent(group.project.id)}`;
        const accessibleProjectLabel = categoryName ? `${workspace} in ${categoryName}` : workspace;
        const draggable = provider === 'erebus';
        return <section className={`erebus-project-group${draggedProject === workspace ? ' is-dragging' : ''}`} key={projectKey}>
            {!collapsed && <button
                type='button'
                className={`erebus-project-heading${draggable ? ' is-draggable' : ''}`}
                onPointerDown={event => beginProjectInteraction(event, workspace, projectKey, draggable)}
                onClick={event => clickProject(event, projectKey)}
                aria-controls={projectSessionsId}
                aria-expanded={!projectCollapsed}
                aria-label={`${projectCollapsed ? 'Expand' : 'Collapse'} ${accessibleProjectLabel} conversations`}
                title={`${projectCollapsed ? 'Expand' : 'Collapse'} ${accessibleProjectLabel}${draggable ? '; drag to categorize' : ''}`}
            >
                <span className='erebus-project-name'>
                    <Icon name='codicon-folder' />
                    <span>{workspace}</span>
                </span>
                <span className='erebus-project-toggle' aria-hidden='true'>
                    <Icon name={projectCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} />
                </span>
            </button>}
            <div id={projectSessionsId}
                className={`erebus-project-sessions${projectCollapsed ? ' is-collapsed' : ''}`}
                aria-hidden={projectCollapsed}
            >
                {!projectCollapsed && (orderedWorkspaceSessions.length > 0
                    ? visibleSessions.map(session => <SessionRow
                        key={session.id}
                        session={session}
                        active={selectedId === session.id}
                        collapsed={collapsed}
                        onSelect={() => onSelect(session.id)}
                        onTogglePin={() => onTogglePin(session.id)}
                        onRename={() => onRenameSession(session.id)}
                        onToggleHidden={() => onToggleHidden(session.id)}
                        onRemove={() => onRemoveSession(session.id)}
                    />)
                    : !collapsed && <span className='erebus-empty-project'>No conversations yet</span>)}
                {!projectCollapsed && !collapsed && orderedWorkspaceSessions.length > visibleLimit && <button
                    type='button'
                    className='erebus-show-more-sessions'
                    onClick={() => setVisibleSessionLimits(current => ({
                        ...current,
                        [projectKey]: visibleLimit + SESSIONS_PER_PROJECT_PAGE
                    }))}
                >Show {Math.min(SESSIONS_PER_PROJECT_PAGE, orderedWorkspaceSessions.length - visibleLimit)} more
                    <small>{visibleLimit} of {orderedWorkspaceSessions.length} shown</small>
                </button>}
            </div>
        </section>;
    };

    const renderCategory = (category: ProjectCategory, categoryProjects: ProjectGroup[], emptyCopy: string): React.ReactElement => {
        const categoryCollapsed = !searching && collapsedCategories.has(category.id);
        const categoryProjectsId = `erebus-category-projects-${category.id}`;
        const dropActive = dropCategoryId === category.id;
        const uncategorized = category.id === UNCATEGORIZED_CATEGORY_ID;
        return <section
            className={`erebus-project-category${uncategorized ? ' is-uncategorized' : ''}${dropActive ? ' is-drop-target' : ''}`}
            key={category.id}
            data-category-id={category.id}
        >
            <div className='erebus-category-heading'>
                <span>{!uncategorized && <Icon name={dropActive ? 'codicon-folder-opened' : 'codicon-folder'} />}{category.name}</span>
                <button
                    type='button'
                    className='erebus-category-toggle'
                    onClick={() => toggleCategory(category.id)}
                    aria-controls={categoryProjectsId}
                    aria-expanded={!categoryCollapsed}
                    aria-label={`${categoryCollapsed ? 'Expand' : 'Collapse'} ${category.name}`}
                    title={`${categoryCollapsed ? 'Expand' : 'Collapse'} ${category.name}`}
                >
                    <Icon name={categoryCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} />
                </button>
            </div>
            <div
                id={categoryProjectsId}
                className={`erebus-category-projects${categoryCollapsed ? ' is-collapsed' : ''}`}
                aria-hidden={categoryCollapsed}
            >
                {categoryProjects.length > 0
                    ? categoryProjects.map(group => renderProject(group, category.name))
                    : <>
                        <button type='button' className='erebus-empty-category-new-project' onClick={onNewProject}>
                            <Icon name='codicon-new-folder' />
                            Create a project
                        </button>
                        <span className='erebus-empty-category'>{emptyCopy}</span>
                    </>}
            </div>
        </section>;
    };

    return <aside className={`erebus-session-rail${collapsed ? ' is-collapsed' : ''}`} aria-label='Agent sessions'>
        <div className='erebus-session-rail-content'>
            {!collapsed && <RailToolbar
                searchQuery={searchQuery}
                categoryView={categoryView}
                showHidden={showHidden}
                tags={availableTags}
                selectedTags={selectedTags}
                onSearchQueryChange={setSearchQuery}
                onToggleCategoryView={() => setCategoryView(current => !current)}
                onToggleShowHidden={() => setShowHidden(current => !current)}
                onSelectAllTags={() => setSelectedTags(new Set())}
                onToggleTag={toggleSelectedTag}
                onCreateTag={createTag}
            />}
            <button type='button' className='erebus-new-session' onClick={onNewSession} title='New session'>
                <Icon name='codicon-edit' />
                {!collapsed && <span>New session</span>}
            </button>

            {!collapsed && <div className='erebus-rail-label'>Projects</div>}

            <div className='erebus-project-groups'>
                {collapsed
                    ? groups.map(group => renderProject(group))
                    : categoryView
                        ? <>
                            {categories.flatMap(category => {
                                const categoryProjects = category.projects.flatMap(project => {
                                    const projectGroup = groups.find(group => group.project.name === project);
                                    return projectGroup ? [projectGroup] : [];
                                });
                                return searching && categoryProjects.length === 0
                                    ? []
                                    : [renderCategory(category, categoryProjects, 'Drag projects here')];
                            })}
                            {(!searching || uncategorizedProjects.length > 0) && renderCategory({
                                id: UNCATEGORIZED_CATEGORY_ID,
                                name: UNCATEGORIZED_CATEGORY_NAME,
                                projects: uncategorizedProjects.map(group => group.project.name)
                            }, uncategorizedProjects, 'New projects appear here')}
                        </>
                        : groups.map(group => renderProject(group))}
                {!collapsed && !searching && <button
                    type='button'
                    className={`erebus-new-category${draggedProject ? ' is-drop-target' : ''}`}
                    data-new-category
                    onClick={() => onCreateCategory()}
                >
                    <Icon name={draggedProject ? 'codicon-new-folder' : 'codicon-add'} />
                    {draggedProject ? 'Drop to create category' : 'New category'}
                </button>}
                {!collapsed && !searching && <button type='button' className='erebus-new-project' onClick={onNewProject}>
                    <Icon name='codicon-new-folder' />
                    New project
                </button>}
                {(Array.from(externalGroups.entries())).filter(([, providerProjects]) => !searching || providerProjects.size > 0).map(([provider, providerProjects]) => {
                    const status = sources.find(source => source.provider === provider);
                    const providerSessions = [...providerProjects.values()].flat();
                    const providerCollapsed = !searching && collapsedProviders.has(provider);
                    const providerContentId = `erebus-provider-content-${provider}`;
                    return <section className={`erebus-provider-group${providerCollapsed ? ' is-collapsed' : ''}`} key={provider}>
                        {!collapsed && <button
                            type='button'
                            className='erebus-provider-heading'
                            onClick={() => toggleProvider(provider)}
                            aria-controls={providerContentId}
                            aria-expanded={!providerCollapsed}
                            aria-label={`${providerCollapsed ? 'Expand' : 'Collapse'} ${providerLabels[provider]} conversations`}
                            title={`${providerCollapsed ? 'Expand' : 'Collapse'} ${providerLabels[provider]} conversations`}
                        >
                            <span className={`erebus-provider-mark is-${provider}`}>{providerMonograms[provider]}</span>
                            <strong>{providerLabels[provider]}</strong>
                            <span>{providerSessions.length}</span>
                        </button>}
                        <div
                            id={providerContentId}
                            className={`erebus-provider-content${providerCollapsed ? ' is-collapsed' : ''}`}
                            aria-hidden={providerCollapsed}
                        >
                            {!providerCollapsed && (providerProjects.size > 0
                                ? [...providerProjects.entries()]
                                    .sort(([left], [right]) => {
                                        if (left === 'Uncategorized') {
                                            return 1;
                                        }
                                        if (right === 'Uncategorized') {
                                            return -1;
                                        }
                                        return left.localeCompare(right);
                                    })
                                    .map(([workspace, workspaceSessions]) => renderProject({
                                        project: {
                                            id: `${provider}-${encodeURIComponent(workspace)}`,
                                            name: workspace,
                                            kind: 'remote',
                                            sourceFolders: [],
                                            tags: Array.from(new Set(workspaceSessions.flatMap(session => session.tags ?? []))),
                                            hidden: workspaceSessions.length > 0 && workspaceSessions.every(session => session.hidden === true)
                                        },
                                        sessions: workspaceSessions
                                    }, undefined, provider))
                                : !collapsed && <div className='erebus-provider-empty'>
                                    {status?.message ?? `No ${providerLabels[provider]} conversations found.`}
                                </div>)}
                        </div>
                    </section>;
                })}
                {!collapsed && searching && groups.length === 0
                    && [...externalGroups.values()].every(providerProjects => providerProjects.size === 0)
                    && <div className='erebus-rail-search-empty'>No matching projects or conversations</div>}
            </div>

        </div>

        <div className='erebus-profile'>
            <span className='erebus-profile-avatar'>E</span>
            {!collapsed && <span className='erebus-profile-copy'>
                <strong>Erebus</strong>
                <small>Local workspace</small>
            </span>}
            <button type='button' className='erebus-icon-button' aria-label='Settings' title='Settings' onClick={onOpenSettings}>
                <Icon name='codicon-settings-gear' />
            </button>
        </div>
    </aside>;
}

function RailResizeHandle({ width, collapsed, onResize }: { width: number; collapsed: boolean; onResize: (width: number) => void }): React.ReactElement {
    const stopResizeRef = useRef<(() => void) | undefined>();
    const [dragging, setDragging] = useState(false);

    useEffect(() => () => stopResizeRef.current?.(), []);

    return <div
        className={`erebus-rail-resizer${dragging ? ' is-active' : ''}`}
        role='separator'
        aria-label='Resize projects and conversation sections'
        aria-orientation='vertical'
        aria-valuemin={collapsed ? 68 : MIN_RAIL_WIDTH}
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuenow={Math.round(width)}
        title='Drag to resize; double-click to reset'
        tabIndex={0}
        onDoubleClick={() => onResize(DEFAULT_RAIL_WIDTH)}
        onPointerDown={event => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            stopResizeRef.current?.();
            const startX = event.clientX;
            const startWidth = collapsed ? 68 : width;
            const move = (moveEvent: PointerEvent): void => onResize(startWidth + moveEvent.clientX - startX);
            const stop = (): void => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', stop);
                window.removeEventListener('pointercancel', stop);
                stopResizeRef.current = undefined;
                setDragging(false);
            };
            stopResizeRef.current = stop;
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
            window.addEventListener('pointercancel', stop);
            setDragging(true);
        }}
        onKeyDown={event => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                onResize((collapsed ? 68 : width) - 16);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                onResize((collapsed ? 68 : width) + 16);
            } else if (event.key === 'Home') {
                event.preventDefault();
                onResize(MIN_RAIL_WIDTH);
            } else if (event.key === 'End') {
                event.preventDefault();
                onResize(MAX_RAIL_WIDTH);
            }
        }}
    />;
}

function ToolDisclosure({ count, details, expanded, onToggle }: {
    count: number;
    details?: FocusToolCall[];
    expanded: boolean;
    onToggle: () => void;
}): React.ReactElement {
    const status = details?.some(tool => tool.status === 'approval') ? 'Needs approval'
        : details?.some(tool => tool.status === 'running') ? 'Running'
            : details?.length ? 'Complete' : 'Reported by source';
    return <div className={`erebus-tool-disclosure${expanded ? ' is-expanded' : ''}`}>
        <button type='button' onClick={onToggle} aria-expanded={expanded}>
            <Icon name='codicon-chevron-right' />
            <span>{count} tool calls</span>
            <span className='erebus-tool-duration'>{status}</span>
        </button>
        {expanded && <div className='erebus-tool-list'>
            {details?.length ? details.map(tool => <span key={tool.id} title={tool.detail}>
                <Icon name={tool.status === 'approval' ? 'codicon-question' : tool.status === 'running' ? 'codicon-sync' : 'codicon-pass'} />
                {tool.name}<small>{tool.status === 'approval' ? 'Awaiting approval' : tool.status === 'running' ? 'Running' : 'Complete'}</small>
            </span>) : Array.from({ length: count }, (_, index) => <span key={index}>
                <Icon name='codicon-tools' />Tool call {index + 1}<small>Status unavailable from source</small>
            </span>)}
        </div>}
    </div>;
}

function ChangeSummary({ files, onOpenChanges }: { files: string[]; onOpenChanges: () => void }): React.ReactElement {
    return <div className='erebus-change-summary'>
        <span><Icon name='codicon-git-compare' />{files.length} files changed</span>
        <button type='button' onClick={onOpenChanges}>
            <Icon name='codicon-eye' />View changes ({files.length})
        </button>
        <button type='button' className='is-muted' title='Review changed files' onClick={onOpenChanges}>
            <Icon name='codicon-diff' />Review diff
        </button>
    </div>;
}

function MessageContext({ context }: { context: FocusContextItem[] }): React.ReactElement {
    return <div className='erebus-message-context' aria-label='Attached context'>
        {context.map(item => <span key={item.id} title={item.paths?.join('\n') ?? item.detail}>
            <Icon name={item.kind === 'folder' || item.kind === 'workspace'
                ? 'codicon-folder'
                : item.kind === 'session' ? 'codicon-notebook' : 'codicon-file'} />
            <span>{item.label}</span>
            {item.detail && <small>{item.detail}</small>}
        </span>)}
    </div>;
}

function MessageExecutionParameters({ parameters }: { parameters: FocusExecutionParameters }): React.ReactElement {
    return <section className='erebus-message-execution-parameters' aria-label='Execution parameters'>
        <header>Execution parameters</header>
        <pre><code>{JSON.stringify(parameters, undefined, 2)}</code></pre>
    </section>;
}

function ConversationMessage({ message, agentName, expanded, onToggleTools, onOpenChanges }: {
    message: FocusMessage;
    agentName: string;
    expanded: boolean;
    onToggleTools: () => void;
    onOpenChanges: () => void;
}): React.ReactElement {
    if (message.role === 'user') {
        return <article className='erebus-message is-user'>
            {!message.executionParameters && message.context && message.context.length > 0 && <MessageContext context={message.context} />}
            <div className='erebus-user-bubble'>
                {message.executionParameters && <MessageExecutionParameters parameters={message.executionParameters} />}
                <MarkdownContent markdown={message.body.join('\n\n')} className='erebus-user-markdown' />
            </div>
        </article>;
    }

    return <article className='erebus-message is-agent'>
        {message.toolCalls && <ToolDisclosure count={message.toolCalls} details={message.toolDetails}
            expanded={expanded} onToggle={onToggleTools} />}
        <header className='erebus-agent-heading'>
            <AgentMark />
            <strong>{message.agentName ?? agentName}</strong>
            <span>Agent</span>
        </header>
        <MarkdownContent markdown={message.body.join('\n\n')} className='erebus-agent-copy' />
        {message.elapsed && <div className='erebus-message-metrics'>
            <span>Elapsed {message.elapsed}</span>
            {message.executionProfile && <span>{message.executionProfile}</span>}
            <span>Local session</span>
        </div>}
        {message.changedFiles && message.changedFiles.length > 0 && <ChangeSummary files={message.changedFiles} onOpenChanges={onOpenChanges} />}
    </article>;
}

function EmptyConversation({ session }: { session: FocusSession }): React.ReactElement {
    return <div className='erebus-empty-conversation'>
        <div className='erebus-empty-orbit'><AgentMark /></div>
        <span className='erebus-eyebrow'>{session.readOnly ? 'Synced conversation' : 'Ready to work'}</span>
        <h2>{session.title}</h2>
        <p>{session.readOnly
            ? session.loading ? `Loading this ${providerLabels[session.provider as ConversationProvider]} conversation…`
                : 'This conversation does not contain any displayable user or agent messages.'
            : 'Describe an outcome, attach context, or select a structured workflow. Erebus will keep the session visible while it works.'}</p>
    </div>;
}

function Composer({ value, busy, readOnly, providerName, workspace, sessionTitle, onChange, onSubmit, onCancel }: {
    value: string;
    busy: boolean;
    readOnly: boolean;
    providerName?: string;
    workspace: string;
    sessionTitle: string;
    onChange: (value: string) => void;
    onSubmit: (submission: ComposerSubmission) => void;
    onCancel: () => void;
}): React.ReactElement {
    const [menuOpen, setMenuOpen] = useState<ComposerMenu | undefined>();
    const [agent, setAgent] = useState<ComposerAgent>(() =>
        loadComposerPreference(COMPOSER_AGENT_STORAGE_KEY, COMPOSER_AGENTS, 'erebus'));
    const [effort, setEffort] = useState<ComposerEffort>(() =>
        loadComposerPreference(COMPOSER_EFFORT_STORAGE_KEY, COMPOSER_EFFORTS, 'balanced'));
    const [access, setAccess] = useState<ComposerAccess>(() =>
        loadComposerPreference(COMPOSER_ACCESS_STORAGE_KEY, COMPOSER_ACCESS_MODES, 'approve'));
    const [autopilot, setAutopilot] = useState(loadComposerAutopilot);
    const [context, setContext] = useState<FocusContextItem[]>([]);
    const composerRef = useRef<HTMLDivElement | undefined>(undefined);
    const fileInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const folderInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const selectedAgent = COMPOSER_AGENTS.find(option => option.value === agent) ?? COMPOSER_AGENTS[0];
    const selectedEffort = COMPOSER_EFFORTS.find(option => option.value === effort) ?? COMPOSER_EFFORTS[1];
    const selectedAccess = COMPOSER_ACCESS_MODES.find(option => option.value === access) ?? COMPOSER_ACCESS_MODES[1];

    useEffect(() => storeComposerPreference(COMPOSER_AGENT_STORAGE_KEY, agent), [agent]);
    useEffect(() => storeComposerPreference(COMPOSER_EFFORT_STORAGE_KEY, effort), [effort]);
    useEffect(() => storeComposerPreference(COMPOSER_ACCESS_STORAGE_KEY, access), [access]);
    useEffect(() => storeComposerPreference(COMPOSER_AUTOPILOT_STORAGE_KEY, autopilot), [autopilot]);

    useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }
        const closeOnPointerDown = (event: PointerEvent): void => {
            if (!composerRef.current?.contains(event.target as Node)) {
                setMenuOpen(undefined);
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setMenuOpen(undefined);
            }
        };
        window.addEventListener('pointerdown', closeOnPointerDown);
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            window.removeEventListener('pointerdown', closeOnPointerDown);
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [menuOpen]);

    useEffect(() => {
        if (readOnly) {
            setMenuOpen(undefined);
        }
    }, [readOnly]);

    const toggleMenu = (menu: ComposerMenu): void => {
        if (!readOnly) {
            setMenuOpen(current => current === menu ? undefined : menu);
        }
    };

    const addFiles = (files: File[]): void => {
        const batchId = Date.now();
        const nextItems = files.map((file, index): FocusContextItem => {
            const path = pathForAttachedFile(file);
            const size = file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KB`;
            return {
                id: `file-${batchId}-${index}`,
                kind: 'file',
                label: file.name,
                detail: size,
                paths: [path]
            };
        });
        setContext(current => [
            ...current,
            ...nextItems.filter(item => !current.some(existing => existing.paths?.[0] === item.paths?.[0]))
        ]);
        setMenuOpen(undefined);
    };

    const addFolder = (files: File[]): void => {
        if (files.length === 0) {
            return;
        }
        const paths = files.map(pathForAttachedFile);
        const relativeRoot = files[0].webkitRelativePath.split('/')[0];
        const firstPath = paths[0];
        const pathParts = firstPath.split(/[\\/]/);
        const fallbackRoot = pathParts.length > 1 ? pathParts[pathParts.length - 2] : undefined;
        const label = relativeRoot || fallbackRoot || 'Attached folder';
        const nextItem: FocusContextItem = {
            id: `folder-${Date.now()}`,
            kind: 'folder',
            label,
            detail: `${files.length} file${files.length === 1 ? '' : 's'}`,
            paths
        };
        setContext(current => current.some(item => item.kind === 'folder' && item.label === label)
            ? current
            : [...current, nextItem]);
        setMenuOpen(undefined);
    };

    const addBuiltInContext = (item: FocusContextItem): void => {
        setContext(current => current.some(existing => existing.kind === item.kind && existing.label === item.label)
            ? current
            : [...current, item]);
        setMenuOpen(undefined);
    };

    const submit = (): void => {
        if (!value.trim() || busy || readOnly) {
            return;
        }
        onSubmit({ agent, effort, access, autopilot, context });
        setContext([]);
        setMenuOpen(undefined);
    };

    return <div className='erebus-composer-wrap'>
        <div ref={element => composerRef.current = element ?? undefined}
            className={`erebus-composer${busy ? ' is-busy' : ''}${readOnly ? ' is-read-only' : ''}`}>
            <div className='erebus-composer-editor'>
                <RichMarkdownEditor
                    value={value}
                    disabled={readOnly}
                    placeholder={readOnly ? `Read-only sync from ${providerName}` : 'Ask a question or describe a task…'}
                    ariaLabel='Message the agent'
                    onChange={onChange}
                    onSubmit={submit}
                />
            </div>
            {context.length > 0 && <div className='erebus-composer-context' aria-label='Pending context'>
                {context.map(item => <span className='erebus-composer-context-chip' key={item.id}
                    title={item.paths?.join('\n') ?? item.detail}>
                    <Icon name={item.kind === 'folder' || item.kind === 'workspace'
                        ? 'codicon-folder'
                        : item.kind === 'session' ? 'codicon-notebook' : 'codicon-file'} />
                    <span>{item.label}</span>
                    {item.detail && <small>{item.detail}</small>}
                    <button type='button' onClick={() => setContext(current => current.filter(candidate => candidate.id !== item.id))}
                        aria-label={`Remove ${item.label}`} title={`Remove ${item.label}`}>
                        <Icon name='codicon-close' />
                    </button>
                </span>)}
            </div>}
            <div className='erebus-composer-toolbar'>
                <div className='erebus-composer-tools'>
                    <span className='erebus-composer-menu-shell'>
                        <button type='button' disabled={readOnly} aria-label='Add context' title='Add context'
                            aria-haspopup='menu' aria-expanded={menuOpen === 'context'}
                            className={menuOpen === 'context' ? 'is-active' : ''} onClick={() => toggleMenu('context')}>
                            <Icon name='codicon-add' />
                        </button>
                        {menuOpen === 'context' && <div className='erebus-composer-menu is-context' role='menu' aria-label='Add context'>
                            <div className='erebus-composer-menu-heading'>Add context</div>
                            <button type='button' className='erebus-composer-menu-item' role='menuitem' onClick={() => fileInputRef.current?.click()}>
                                <Icon name='codicon-files' /><span><strong>Files</strong><small>Choose one or more files</small></span>
                            </button>
                            <button type='button' className='erebus-composer-menu-item' role='menuitem' onClick={() => folderInputRef.current?.click()}>
                                <Icon name='codicon-folder-opened' /><span><strong>Folder</strong><small>Attach the contents of a folder</small></span>
                            </button>
                            <button type='button' className='erebus-composer-menu-item' role='menuitem'
                                disabled={context.some(item => item.kind === 'workspace' && item.label === workspace)}
                                onClick={() => addBuiltInContext({
                                    id: `workspace-${Date.now()}`,
                                    kind: 'workspace',
                                    label: workspace,
                                    detail: 'Workspace context'
                                })}>
                                <Icon name='codicon-root-folder' /><span><strong>Current workspace</strong><small>{workspace}</small></span>
                            </button>
                            <button type='button' className='erebus-composer-menu-item' role='menuitem'
                                disabled={context.some(item => item.kind === 'session' && item.label === sessionTitle)}
                                onClick={() => addBuiltInContext({
                                    id: `session-${Date.now()}`,
                                    kind: 'session',
                                    label: sessionTitle,
                                    detail: 'Active session brief'
                                })}>
                                <Icon name='codicon-notebook' /><span><strong>Session brief</strong><small>{sessionTitle}</small></span>
                            </button>
                        </div>}
                    </span>
                    <button type='button' disabled={readOnly} aria-label='Attach files' title='Attach files'
                        onClick={() => fileInputRef.current?.click()}><Icon name='codicon-attach' /></button>
                    <span className='erebus-composer-menu-shell'>
                        <button type='button' className='erebus-select-button' disabled={readOnly}
                            aria-haspopup='menu' aria-expanded={menuOpen === 'agent'} onClick={() => toggleMenu('agent')}>
                            <AgentMark small />{readOnly ? providerName : selectedAgent.label}<Icon name='codicon-chevron-down' />
                        </button>
                        {menuOpen === 'agent' && <div className='erebus-composer-menu is-agent' role='menu' aria-label='Select agent'>
                            <div className='erebus-composer-menu-heading'>Agent</div>
                            {COMPOSER_AGENTS.map(option => <button type='button' className='erebus-composer-menu-item'
                                role='menuitemradio' aria-checked={agent === option.value} key={option.value}
                                onClick={() => { setAgent(option.value); setMenuOpen(undefined); }}>
                                <Icon name={option.icon} /><span><strong>{option.label}</strong><small>{option.detail}</small></span>
                                {agent === option.value && <Icon name='codicon-check' className='erebus-menu-check' />}
                            </button>)}
                        </div>}
                    </span>
                    <span className='erebus-composer-menu-shell'>
                        <button type='button' className='erebus-select-button erebus-effort-button' disabled={readOnly}
                            aria-haspopup='menu' aria-expanded={menuOpen === 'effort'} onClick={() => toggleMenu('effort')}>
                            {selectedEffort.label}<Icon name='codicon-chevron-down' />
                        </button>
                        {menuOpen === 'effort' && <div className='erebus-composer-menu is-effort' role='menu' aria-label='Select effort'>
                            <div className='erebus-composer-menu-heading'>Effort</div>
                            {COMPOSER_EFFORTS.map(option => <button type='button' className='erebus-composer-menu-item'
                                role='menuitemradio' aria-checked={effort === option.value} key={option.value}
                                onClick={() => { setEffort(option.value); setMenuOpen(undefined); }}>
                                <Icon name={option.icon} /><span><strong>{option.label}</strong><small>{option.detail}</small></span>
                                {effort === option.value && <Icon name='codicon-check' className='erebus-menu-check' />}
                            </button>)}
                        </div>}
                    </span>
                    <span className='erebus-composer-menu-shell'>
                        <button type='button' className={`erebus-select-button erebus-access-button is-${access}`} disabled={readOnly}
                            aria-haspopup='menu' aria-expanded={menuOpen === 'access'} onClick={() => toggleMenu('access')}>
                            <Icon name={selectedAccess.icon} />{selectedAccess.label}<Icon name='codicon-chevron-down' />
                        </button>
                        {menuOpen === 'access' && <div className='erebus-composer-menu is-access' role='menu' aria-label='Select access mode'>
                            <div className='erebus-access-heading'>How should Erebus actions be approved?</div>
                            {COMPOSER_ACCESS_MODES.map(option => <button type='button'
                                className={`erebus-composer-menu-item erebus-access-option${option.value === 'full' ? ' is-full' : ''}`}
                                role='menuitemradio' aria-checked={access === option.value} key={option.value}
                                onClick={() => { setAccess(option.value); setMenuOpen(undefined); }}>
                                <Icon name={option.icon} /><span><strong>{option.label}</strong><small>{option.detail}</small></span>
                                {access === option.value && <Icon name='codicon-check' className='erebus-menu-check' />}
                            </button>)}
                        </div>}
                    </span>
                </div>
                <div className='erebus-composer-actions'>
                    <label className='erebus-autopilot-toggle'>
                        <span>Autopilot</span>
                        <input type='checkbox' checked={autopilot} disabled={readOnly}
                            onChange={event => setAutopilot(event.currentTarget.checked)} />
                        <span className='erebus-toggle-track'><span /></span>
                    </label>
                    <button
                        type='button'
                        className={`erebus-send-button${busy ? ' is-stop' : ''}`}
                        onClick={busy ? onCancel : submit}
                        disabled={readOnly || (!busy && !value.trim())}
                        aria-label={busy ? 'Stop agent' : 'Send message'}
                        title={busy ? 'Stop agent' : 'Send message'}
                    >
                        <Icon name={busy ? 'codicon-debug-stop' : 'codicon-arrow-up'} />
                    </button>
                </div>
            </div>
        </div>
        <input ref={element => fileInputRef.current = element ?? undefined}
            className='erebus-hidden-file-input' type='file' multiple onChange={event => {
            addFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
        }} />
        <input ref={element => folderInputRef.current = element ?? undefined}
            className='erebus-hidden-file-input' type='file' multiple {...{ webkitdirectory: '' }} onChange={event => {
            addFolder(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
        }} />
        <div className='erebus-composer-hint'>{readOnly
            ? `Read-only local sync · Continue this thread in ${providerName}`
            : 'Enter to send · Shift+Enter for a new line'}</div>
    </div>;
}

function ContextPanel({ session, busy, tab, selectedFile, onTabChange, onClose, onRunTasks, onRunTask, onSetTaskComplete, onSelectFile,
    onOpenChange, onReviewChange, onCommentOnChange }: {
    session: FocusSession;
    busy: boolean;
    tab: 'context' | 'changes';
    selectedFile?: string;
    onTabChange: (tab: 'context' | 'changes') => void;
    onClose: () => void;
    onRunTasks: () => void;
    onRunTask: (taskId: string) => void;
    onSetTaskComplete: (taskId: string, complete: boolean) => void;
    onSelectFile: (file: string) => void;
    onOpenChange: (file: string) => void;
    onReviewChange: (file: string, state: 'accepted' | 'rejected') => void;
    onCommentOnChange: (file: string) => void;
}): React.ReactElement {
    const completedTasks = session.tasks.filter(task => task.complete).length;
    const progress = session.tasks.length === 0 ? 0 : Math.round((completedTasks / session.tasks.length) * 100);
    const pendingTasks = session.tasks.filter(task => !task.complete);
    const activeFile = selectedFile && session.changedFiles.includes(selectedFile) ? selectedFile : session.changedFiles[0];
    const reviewState = activeFile ? session.changeReviews?.[activeFile] ?? 'pending' : undefined;

    return <aside className='erebus-context-panel' aria-label='Session context'>
        <header className='erebus-context-header'>
            <div className='erebus-context-tabs' role='tablist' aria-label='Context views'>
                <button type='button' role='tab' aria-selected={tab === 'context'}
                    className={tab === 'context' ? 'is-active' : ''} onClick={() => onTabChange('context')}>Context</button>
                <button type='button' role='tab' aria-selected={tab === 'changes'}
                    className={tab === 'changes' ? 'is-active' : ''} onClick={() => onTabChange('changes')}>Changes</button>
            </div>
            <button type='button' className='erebus-icon-button' onClick={onClose} aria-label='Close context panel' title='Close panel'>
                <Icon name='codicon-close' />
            </button>
        </header>

        {tab === 'context' ? <div className='erebus-context-scroll'>
            <span className='erebus-eyebrow'>Active brief</span>
            <h2>{session.title}</h2>
            {session.workflow && <span className='erebus-workflow-badge'><Icon name='codicon-git-pull-request-new-changes' />{session.workflow} workflow</span>}

            <section className='erebus-context-section'>
                <h3>Requirement</h3>
                <p>{session.requirement}</p>
            </section>

            <section className='erebus-context-section'>
                <h3>Design direction</h3>
                <ul>{session.designNotes.map(note => <li key={note}>{note}</li>)}</ul>
            </section>

            <section className='erebus-context-section erebus-task-section'>
                <div className='erebus-section-heading'>
                    <h3>Tasks</h3>
                    <strong>{completedTasks}/{session.tasks.length}</strong>
                </div>
                <div className='erebus-progress-track' aria-label={`${progress}% complete`}>
                    <span style={{ width: `${progress}%` }} />
                </div>
                <button type='button' className='erebus-primary-button erebus-run-tasks-button'
                    onClick={onRunTasks} disabled={busy || pendingTasks.length === 0}>
                    <Icon name='codicon-play' />
                    <span>{busy ? 'Agent is working' : session.tasks.length === 0 ? 'No workflow tasks'
                        : pendingTasks.length === 0 ? 'All tasks complete' : 'Run remaining tasks'}</span>
                </button>
                <div className='erebus-task-list'>
                    {session.tasks.map(task => <div className={`erebus-task-item${task.complete ? ' is-complete' : ''}`} key={task.id}>
                        <button type='button' className='erebus-task-row' onClick={() => onRunTask(task.id)} disabled={busy || task.complete}>
                            <Icon name={task.complete ? 'codicon-pass-filled' : task.awaitingReview ? 'codicon-eye' : 'codicon-circle-large-outline'} />
                            <span>{task.label}<small>{task.complete ? 'Confirmed complete' : task.awaitingReview ? 'Ready for your review' : 'Not started'}</small></span>
                            {!task.complete && !task.awaitingReview && <Icon name='codicon-play' className='erebus-task-run-icon' />}
                        </button>
                        {task.awaitingReview && !task.complete && <button type='button' className='erebus-task-confirm'
                            onClick={() => onSetTaskComplete(task.id, true)} disabled={busy}>Confirm done</button>}
                        {task.complete && <button type='button' className='erebus-task-confirm'
                            onClick={() => onSetTaskComplete(task.id, false)} disabled={busy}>Reopen</button>}
                    </div>)}
                </div>
            </section>

            <section className='erebus-context-section'>
                <h3>Changed files</h3>
                <div className='erebus-file-list'>
                    {session.changedFiles.length > 0 ? session.changedFiles.map(file => <button type='button' key={file} onClick={() => {
                        onSelectFile(file);
                        onTabChange('changes');
                    }}>
                        <Icon name='codicon-file-code' />
                        <span>{file}</span>
                        <Icon name='codicon-chevron-right' />
                    </button>) : <p className='erebus-empty-state'>No files changed in this session.</p>}
                </div>
            </section>
        </div> : <div className='erebus-context-scroll'>
            <div className='erebus-diff-heading'>
                <div>
                    <span className='erebus-eyebrow'>Inline review</span>
                    <h2>{activeFile ?? 'No changes yet'}</h2>
                </div>
                {reviewState && <span className={`erebus-review-state is-${reviewState}`}>{reviewState}</span>}
            </div>
            {activeFile ? <>
                <div className='erebus-changed-file-picker' role='listbox' aria-label='Changed files'>
                    {session.changedFiles.map(file => <button type='button' role='option' aria-selected={file === activeFile}
                        className={file === activeFile ? 'is-active' : ''} key={file} onClick={() => onSelectFile(file)}>
                        <Icon name='codicon-file-code' /><span>{file}</span>
                        {session.changeReviews?.[file] && <Icon name={session.changeReviews[file] === 'accepted'
                            ? 'codicon-pass-filled' : 'codicon-circle-slash'} />}
                    </button>)}
                </div>
                <div className='erebus-diff-card erebus-diff-summary' aria-label={`Review ${activeFile}`}>
                    <Icon name='codicon-git-compare' />
                    <strong>{reviewState === 'pending' ? 'Ready for review' : `Change ${reviewState}`}</strong>
                    <p>Open the live diff for exact hunks, or accept and reject this file directly from Agent Focus.</p>
                    <button type='button' onClick={() => onOpenChange(activeFile)}><Icon name='codicon-open-preview' />Open full diff</button>
                </div>
                <div className='erebus-review-actions'>
                    <button type='button' onClick={() => onCommentOnChange(activeFile)}><Icon name='codicon-comment' />Comment</button>
                    <button type='button' disabled={reviewState === 'rejected'} onClick={() => onReviewChange(activeFile, 'rejected')}>
                        <Icon name='codicon-close' />Reject
                    </button>
                    <button type='button' className='erebus-primary-button' disabled={reviewState === 'accepted'}
                        onClick={() => onReviewChange(activeFile, 'accepted')}><Icon name='codicon-check' />Accept</button>
                </div>
            </> : <p className='erebus-empty-state'>Changes will appear here as the agent edits files.</p>}
        </div>}
    </aside>;
}

function AttentionPanel({ sessions, onSelect, onClose, onResolve }: {
    sessions: FocusSession[];
    onSelect: (id: string) => void;
    onClose: () => void;
    onResolve: (id: string, optionId: string) => void;
}): React.ReactElement {
    const attentionSessions = sessions.filter((session): session is FocusSession & { attention: FocusAttentionRequest } => Boolean(session.attention));
    return <aside className='erebus-attention-panel' aria-label='Attention requests'>
        <header>
            <div>
                <span className='erebus-eyebrow'>Action required</span>
                <h2>Attention</h2>
            </div>
            <button type='button' className='erebus-icon-button' onClick={onClose} aria-label='Close attention panel'><Icon name='codicon-close' /></button>
        </header>
        {attentionSessions.length === 0 ? <div className='erebus-attention-empty'>
            <Icon name='codicon-pass-filled' />
            <strong>You are all caught up</strong>
            <span>Blocked sessions will collect here.</span>
        </div> : attentionSessions.map(session => {
            const request = session.attention;
            return <article className={`erebus-attention-card${request.timedOut ? ' is-timed-out' : ''}`} key={session.id}>
                <span className='erebus-attention-project'>{session.workspace}</span>
                <h3>{session.title}</h3>
                <strong>{request.title}</strong>
                <p>{request.message}</p>
                {request.detail && <code>{request.detail}</code>}
                {request.timedOut ? <span className='erebus-attention-expired'>This request timed out.</span> : <div>
                    {request.options.map(option => <button type='button' key={option.id}
                        className={`${option.primary ? 'erebus-primary-button' : ''}${option.destructive ? ' is-danger' : ''}`}
                        title={option.description} onClick={() => onResolve(session.id, option.id)}>{option.label}</button>)}
                </div>}
                <button type='button' className='erebus-attention-open-session' onClick={() => onSelect(session.id)}>
                    Open session<Icon name='codicon-arrow-right' />
                </button>
            </article>;
        })}
    </aside>;
}

function NewSessionDialog({ workspaces, onClose, onCreate }: {
    workspaces: string[];
    onClose: () => void;
    onCreate: (input: NewSessionInput) => void;
}): React.ReactElement {
    const [selected, setSelected] = useState<WorkflowKind | undefined>('Spec');
    const [workspace, setWorkspace] = useState(workspaces[0] ?? 'Erebus');
    const dialogRef = useDialogFocus<HTMLElement>(onClose);
    return <div className='erebus-dialog-backdrop' role='presentation' onMouseDown={event => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }}>
        <section ref={element => dialogRef.current = element ?? undefined} tabIndex={-1}
            className='erebus-new-session-dialog' role='dialog' aria-modal='true' aria-labelledby='erebus-new-session-title'>
            <header>
                <div>
                    <span className='erebus-eyebrow'>Start with structure or chat freely</span>
                    <h2 id='erebus-new-session-title'>New agent session</h2>
                </div>
                <button type='button' className='erebus-icon-button' onClick={onClose} aria-label='Close'><Icon name='codicon-close' /></button>
            </header>
            <div className='erebus-dialog-project'>
                <span><Icon name='codicon-folder-opened' />Workspace</span>
                <label>
                    <span className='theia-sr-only'>Workspace</span>
                    <select data-dialog-initial-focus value={workspace} onChange={event => setWorkspace(event.currentTarget.value)}>
                        {workspaces.map(option => <option value={option} key={option}>{option}</option>)}
                    </select>
                    <Icon name='codicon-chevron-down' />
                </label>
            </div>
            <div className='erebus-workflow-grid'>
                {WORKFLOWS.map(workflow => <button
                    type='button'
                    key={workflow.kind}
                    className={selected === workflow.kind ? 'is-selected' : ''}
                    onClick={() => setSelected(workflow.kind)}
                >
                    <span className='erebus-workflow-icon'><Icon name={workflow.icon} /></span>
                    <strong>{workflow.kind}</strong>
                    <span>{workflow.description}</span>
                    {selected === workflow.kind && <Icon name='codicon-check' className='erebus-workflow-check' />}
                </button>)}
            </div>
            <footer>
                <button type='button' onClick={() => onCreate({ workspace })}>Start freeform</button>
                <button type='button' className='erebus-primary-button' onClick={() => onCreate({ workflow: selected, workspace })}>
                    Create {selected ?? 'session'}<Icon name='codicon-arrow-right' />
                </button>
            </footer>
        </section>
    </div>;
}

function NewCategoryDialog({ project, categoryNames, onClose, onCreate }: {
    project?: string;
    categoryNames: string[];
    onClose: () => void;
    onCreate: (name: string) => void;
}): React.ReactElement {
    const [name, setName] = useState('');
    const trimmedName = name.trim();
    const duplicateName = categoryNames.some(categoryName => categoryName.toLocaleLowerCase() === trimmedName.toLocaleLowerCase());
    const canCreate = trimmedName.length > 0 && !duplicateName;
    const dialogRef = useDialogFocus<HTMLFormElement>(onClose);

    return <div className='erebus-dialog-backdrop' role='presentation' onMouseDown={event => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }}>
        <form ref={element => dialogRef.current = element ?? undefined} tabIndex={-1}
            className='erebus-new-category-dialog' role='dialog' aria-modal='true' aria-labelledby='erebus-new-category-title'
            onSubmit={event => {
                event.preventDefault();
                if (canCreate) {
                    onCreate(trimmedName);
                }
            }}>
            <header>
                <div>
                    <span className='erebus-eyebrow'>{project ? 'Organize this project' : 'Organize related projects'}</span>
                    <h2 id='erebus-new-category-title'>New category</h2>
                </div>
                <button type='button' className='erebus-icon-button' onClick={onClose} aria-label='Close'><Icon name='codicon-close' /></button>
            </header>
            {project && <p className='erebus-category-project-preview'>
                <Icon name='codicon-folder' />
                <span><strong>{project}</strong> will be moved into this category.</span>
            </p>}
            <label className='erebus-category-name-field'>
                <span>Category name</span>
                <input
                    autoFocus data-dialog-initial-focus
                    value={name}
                    onChange={event => setName(event.currentTarget.value)}
                    placeholder='For example, Platform'
                    aria-invalid={duplicateName || undefined}
                    aria-describedby={duplicateName ? 'erebus-category-name-error' : undefined}
                />
            </label>
            {duplicateName && <span id='erebus-category-name-error' className='erebus-category-name-error'>That category already exists.</span>}
            <footer>
                <button type='button' onClick={onClose}>Cancel</button>
                <button type='submit' className='erebus-primary-button' disabled={!canCreate}>Create category</button>
            </footer>
        </form>
    </div>;
}

function NewProjectDialog({ projectNames, onClose, onCreate }: {
    projectNames: string[];
    onClose: () => void;
    onCreate: (project: NewProjectInput) => void;
}): React.ReactElement {
    const [step, setStep] = useState<'type' | 'details'>('type');
    const [kind, setKind] = useState<ProjectKind>('local');
    const [name, setName] = useState('');
    const [sourceFolders, setSourceFolders] = useState<string[]>([]);
    const [remoteFolder, setRemoteFolder] = useState('');
    const folderInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const trimmedName = name.trim();
    const duplicateName = projectNames.some(projectName => projectName.toLocaleLowerCase() === trimmedName.toLocaleLowerCase());
    const canCreate = trimmedName.length > 0 && !duplicateName && sourceFolders.length > 0;
    const dialogRef = useDialogFocus<HTMLFormElement>(onClose);

    const addLocalFolder = (files: File[]): void => {
        const folder = folderSelectionFromFiles(files);
        if (!folder) {
            return;
        }
        setSourceFolders(current => current.includes(folder.path) ? current : [...current, folder.path]);
        setName(current => current.trim() ? current : folder.name);
    };
    const addRemoteFolder = (): void => {
        const trimmedFolder = remoteFolder.trim();
        if (!trimmedFolder) {
            return;
        }
        setSourceFolders(current => current.includes(trimmedFolder) ? current : [...current, trimmedFolder]);
        const pathParts = trimmedFolder.split(/[\\/]/).filter(Boolean);
        setName(current => current.trim() ? current : pathParts[pathParts.length - 1] ?? current);
        setRemoteFolder('');
    };

    return <div className='erebus-dialog-backdrop' role='presentation' onMouseDown={event => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }}>
        <form ref={element => dialogRef.current = element ?? undefined} tabIndex={-1}
            className='erebus-new-project-dialog' role='dialog' aria-modal='true' aria-labelledby='erebus-new-project-title'
            onSubmit={event => {
                event.preventDefault();
                if (step === 'details' && canCreate) {
                    onCreate({ name: trimmedName, kind, sourceFolders });
                }
            }}>
            <header>
                <h2 id='erebus-new-project-title'>Create project</h2>
                <button type='button' className='erebus-icon-button' onClick={onClose} aria-label='Close'><Icon name='codicon-close' /></button>
            </header>
            {step === 'type' ? <>
                <span className='erebus-project-dialog-label'>Project type</span>
                <div className='erebus-project-type-grid'>
                    <button type='button' data-dialog-initial-focus className={kind === 'local' ? 'is-selected' : ''} onClick={() => setKind('local')}
                        aria-pressed={kind === 'local'}>
                        <Icon name='codicon-device-desktop' />
                        <span><strong>Local</strong><small>Edit, run, and test files on your computer</small></span>
                        <span className='erebus-project-type-radio' aria-hidden='true'><span /></span>
                    </button>
                    <button type='button' className={kind === 'remote' ? 'is-selected' : ''} onClick={() => setKind('remote')}
                        aria-pressed={kind === 'remote'}>
                        <Icon name='codicon-globe' />
                        <span><strong>Remote</strong><small>Use a folder on a connected machine</small></span>
                        <span className='erebus-project-type-radio' aria-hidden='true'><span /></span>
                    </button>
                </div>
                <footer>
                    <button type='button' className='erebus-primary-button' onClick={() => setStep('details')}>Next</button>
                </footer>
            </> : <>
                <button type='button' className='erebus-project-type-summary' onClick={() => setStep('type')}>
                    <Icon name={kind === 'local' ? 'codicon-device-desktop' : 'codicon-globe'} />
                    {kind === 'local' ? 'Local project' : 'Remote project'}
                    <span>Change</span>
                </button>
                <label className='erebus-project-name-field'>
                    <span>Project name</span>
                    <span className='erebus-project-name-input'>
                        <Icon name='codicon-folder' />
                        <input autoFocus value={name} onChange={event => setName(event.currentTarget.value)}
                            placeholder='Project name' aria-invalid={duplicateName || undefined}
                            aria-describedby={duplicateName ? 'erebus-project-name-error' : undefined} />
                    </span>
                </label>
                {duplicateName && <span id='erebus-project-name-error' className='erebus-category-name-error'>That project already exists.</span>}
                <span className='erebus-project-dialog-label'>Source folders</span>
                {kind === 'local' ? <button type='button' className='erebus-project-folder-picker'
                    onClick={() => folderInputRef.current?.click()}>
                    <Icon name='codicon-folder-opened' />
                    <span>{sourceFolders.length === 0 ? 'Add folders Erebus can read and edit' : 'Add another source folder'}</span>
                </button> : <div className='erebus-remote-folder-row'>
                    <input value={remoteFolder} onChange={event => setRemoteFolder(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                addRemoteFolder();
                            }
                        }} placeholder='Connected machine path' aria-label='Remote source folder path' />
                    <button type='button' onClick={addRemoteFolder} disabled={!remoteFolder.trim()}>Add</button>
                </div>}
                {sourceFolders.length > 0 && <div className='erebus-project-folder-list' aria-label='Selected source folders'>
                    {sourceFolders.map(folder => <span key={folder} title={folder}>
                        <Icon name={kind === 'local' ? 'codicon-folder' : 'codicon-remote'} />
                        <span>{folder}</span>
                        <button type='button' onClick={() => setSourceFolders(current => current.filter(candidate => candidate !== folder))}
                            aria-label={`Remove ${folder}`} title='Remove folder'><Icon name='codicon-close' /></button>
                    </span>)}
                </div>}
                <footer>
                    <button type='button' onClick={onClose}>Cancel</button>
                    <button type='submit' className='erebus-primary-button' disabled={!canCreate}>Create project</button>
                </footer>
            </>}
            <input ref={element => folderInputRef.current = element ?? undefined} className='erebus-hidden-file-input'
                type='file' multiple {...{ webkitdirectory: '' }} onChange={event => {
                    addLocalFolder(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                }} />
        </form>
    </div>;
}

function SettingsPanel({ railCollapsed, contextOpen, sources, checkingForUpdates, onToggleRail, onToggleContext,
    onCheckForUpdates, onOpenFullSettings }: {
    railCollapsed: boolean;
    contextOpen: boolean;
    sources: ConversationSourceStatus[];
    checkingForUpdates: boolean;
    onToggleRail: () => void;
    onToggleContext: () => void;
    onCheckForUpdates: () => void;
    onOpenFullSettings: () => void;
}): React.ReactElement {
    return <main className='erebus-settings-panel'>
        <div className='erebus-settings-column'>
            <span className='erebus-eyebrow'>Focus mode preferences</span>
            <h1>Settings</h1>
            <p className='erebus-settings-intro'>Keep the focused workspace quiet and intentional. Advanced model, tool, and provider settings remain available in the full IDE.</p>

            <section className='erebus-settings-section'>
                <header><Icon name='codicon-layout' /><div><h2>Layout</h2><p>Choose which supporting surfaces remain visible.</p></div></header>
                <label className='erebus-settings-toggle'>
                    <span><strong>Session rail</strong><small>Show projects and conversations on the left.</small></span>
                    <input type='checkbox' checked={!railCollapsed} onChange={onToggleRail} />
                    <span className='erebus-toggle-track'><span /></span>
                </label>
                <label className='erebus-settings-toggle'>
                    <span><strong>Context panel</strong><small>Show the brief, tasks, and live change review.</small></span>
                    <input type='checkbox' checked={contextOpen} onChange={onToggleContext} />
                    <span className='erebus-toggle-track'><span /></span>
                </label>
            </section>

            <section className='erebus-settings-section'>
                <header><Icon name='codicon-plug' /><div><h2>Conversation sources</h2><p>Read-only conversations discovered on this machine.</p></div></header>
                <div className='erebus-settings-source-list'>
                    {EXTERNAL_PROVIDER_ORDER.map(provider => {
                        const source = sources.find(candidate => candidate.provider === provider);
                        return <div key={provider}>
                            <span className='erebus-session-monogram' style={{ '--session-accent': providerAccents[provider] } as React.CSSProperties}>
                                {providerMonograms[provider]}
                            </span>
                            <span><strong>{providerLabels[provider]}</strong><small>{source?.message ?? (source?.available ? 'Connected' : 'Not detected')}</small></span>
                            <em className={source?.available ? 'is-connected' : ''}>{source?.conversationCount ?? 0} sessions</em>
                        </div>;
                    })}
                </div>
            </section>

            <section className='erebus-settings-section erebus-settings-actions'>
                <header><Icon name='codicon-tools' /><div><h2>Application</h2>
                    <p>Use the full settings editor for provider credentials, model selection, and tool policies.</p>
                </div></header>
                <div>
                    <button type='button' onClick={onCheckForUpdates} disabled={checkingForUpdates}>
                        <Icon name='codicon-cloud-download' className={checkingForUpdates ? 'codicon-modifier-spin' : ''} />
                        {checkingForUpdates ? 'Checking…' : 'Check for updates'}
                    </button>
                    <button type='button' className='erebus-primary-button' onClick={onOpenFullSettings}>
                        <Icon name='codicon-settings-gear' />Open full settings
                    </button>
                </div>
            </section>
        </div>
    </main>;
}

function WelcomePanel({ onNewSession, onNewProject }: { onNewSession: () => void; onNewProject: () => void }): React.ReactElement {
    return <main className='erebus-welcome-panel'>
        <div className='erebus-welcome-card'>
            <AgentMark />
            <span className='erebus-eyebrow'>Agent Focus</span>
            <h1>Start focused work</h1>
            <p>Create a workflow-backed session for implementation, planning, or a bug fix. Every task remains yours to review and confirm.</p>
            <div className='erebus-welcome-actions'>
                <button type='button' className='erebus-primary-button' onClick={onNewSession}>
                    <Icon name='codicon-add' />New session
                </button>
                <button type='button' onClick={onNewProject}>
                    <Icon name='codicon-new-folder' />New project
                </button>
            </div>
        </div>
    </main>;
}

function TopBar({ title, subtitle, railCollapsed, contextOpen, attentionCount, refreshing, canGoBack, canGoForward,
    onToggleRail, onBack, onForward, onRefresh, onToggleContext, onToggleAttention, onExitFocusMode }: {
    title: string;
    subtitle: string;
    railCollapsed: boolean;
    contextOpen: boolean;
    attentionCount: number;
    refreshing: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    onToggleRail: () => void;
    onBack: () => void;
    onForward: () => void;
    onRefresh: () => void;
    onToggleContext: () => void;
    onToggleAttention: () => void;
    onExitFocusMode: () => void;
}): React.ReactElement {
    return <header className='erebus-topbar'>
        <div className='erebus-topbar-left'>
            <button type='button' className='erebus-icon-button' data-agent-focus-autofocus onClick={onToggleRail}
                aria-label={railCollapsed ? 'Expand session rail' : 'Collapse session rail'}
                title={railCollapsed ? 'Expand sessions' : 'Collapse sessions'}>
                <Icon name={railCollapsed ? 'codicon-layout-sidebar-left' : 'codicon-layout-sidebar-left-off'} />
            </button>
            <span className='erebus-topbar-divider' />
            <button type='button' className='erebus-icon-button erebus-navigation-control' onClick={onBack} disabled={!canGoBack}
                aria-label='Go back' title='Back (Ctrl+[)'><Icon name='codicon-arrow-left' /></button>
            <button type='button' className='erebus-icon-button erebus-navigation-control' onClick={onForward} disabled={!canGoForward}
                aria-label='Go forward' title='Forward (Ctrl+])'><Icon name='codicon-arrow-right' /></button>
            <span className='erebus-topbar-divider' />
            <button
                type='button'
                className='erebus-icon-button erebus-navigation-control'
                onClick={onRefresh}
                disabled={refreshing}
                aria-label={refreshing ? 'Refreshing view' : 'Refresh view'}
                aria-busy={refreshing}
                title={refreshing ? 'Refreshing…' : 'Refresh'}
            >
                <Icon name='codicon-refresh' className={refreshing ? 'codicon-modifier-spin' : ''} />
            </button>
        </div>

        <div className='erebus-topbar-title' onDoubleClick={toggleElectronWindowMaximized}
            title='Double-click to maximize or restore'>
            <strong>{title}</strong>
            <span>{subtitle}</span>
        </div>

        <div className='erebus-topbar-actions'>
            <span className='erebus-experimental-badge'>Agent Focus</span>
            <button type='button'
                className={`erebus-icon-button erebus-attention-button${attentionCount > 0 ? ' has-attention' : ''}`}
                onClick={onToggleAttention} aria-label={`${attentionCount} attention requests`} title='Attention requests'>
                <Icon name='codicon-bell' />
                {attentionCount > 0 && <span>{attentionCount}</span>}
            </button>
            <button type='button' className={`erebus-icon-button${contextOpen ? ' is-active' : ''}`}
                onClick={onToggleContext} aria-label='Toggle context panel' title='Toggle context panel'>
                <Icon name='codicon-layout-sidebar-right' />
            </button>
            <button type='button' className='erebus-ide-button' onClick={onExitFocusMode} title='Return to the full Theia IDE'>
                <Icon name='codicon-code' />IDE
            </button>
            <WindowControls />
        </div>
    </header>;
}

export function AgentFocusView({ conversationSyncService, chatService, chatAgentService, toolConfirmationManager, toolInvocationRegistry, onExitFocusMode,
    onOpenFullSettings, onCheckForUpdates }: AgentFocusViewProps): React.ReactElement {
    const initialSessions = useMemo(loadLocalSessions, []);
    const initialSelectedId = useMemo(() => loadSelectedSessionId(initialSessions), [initialSessions]);
    const initialTarget = useMemo<NavigationTarget>(() => initialSelectedId
        ? { kind: 'session', sessionId: initialSelectedId } : { kind: 'home' }, [initialSelectedId]);
    const [sessions, setSessions] = useState<FocusSession[]>(initialSessions);
    const [selectedId, setSelectedId] = useState(initialSelectedId);
    const [conversationSources, setConversationSources] = useState<ConversationSourceStatus[]>([]);
    const [railWidth, setRailWidth] = useState(loadRailWidth);
    const [projects, setProjects] = useState<ProjectDefinition[]>(loadProjects);
    const [categories, setCategories] = useState<ProjectCategory[]>(loadProjectCategories);
    const [railCollapsed, setRailCollapsed] = useState(() => {
        try {
            return window.localStorage.getItem('erebus.agentFocus.railCollapsed') === 'true';
        } catch {
            return false;
        }
    });
    const [contextOpen, setContextOpen] = useState(() => loadStoredBoolean(CONTEXT_OPEN_STORAGE_KEY, true));
    const [contextTab, setContextTab] = useState<'context' | 'changes'>(() => {
        try {
            return window.localStorage.getItem(CONTEXT_TAB_STORAGE_KEY) === 'changes' ? 'changes' : 'context';
        } catch {
            return 'context';
        }
    });
    const [attentionOpen, setAttentionOpen] = useState(false);
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [categoryDialog, setCategoryDialog] = useState<{ project?: string } | undefined>();
    const [composer, setComposer] = useState('');
    const [activeRequestSessions, setActiveRequestSessions] = useState<ReadonlySet<string>>(() => new Set());
    const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
    const [toast, setToast] = useState<string | undefined>();
    const [refreshing, setRefreshing] = useState(false);
    const [checkingForUpdates, setCheckingForUpdates] = useState(false);
    const [selectedChangeFile, setSelectedChangeFile] = useState<string | undefined>();
    const [navigationHistory, setNavigationHistory] = useState<NavigationTarget[]>([initialTarget]);
    const [navigationIndex, setNavigationIndex] = useState(0);
    const [activeSurface, setActiveSurface] = useState<NavigationTarget>(initialTarget);
    const chatEndRef = useRef<HTMLDivElement | undefined>(undefined);
    const selectedIdRef = useRef(selectedId);
    const loadedConversationVersions = useRef(new Map<string, string>());
    const refreshInFlight = useRef(false);
    const activeRequestsRef = useRef(new Map<string, ActiveAgentRequest>());
    const responseDisposablesRef = useRef(new Map<string, Disposable[]>());
    const interactionRefs = useRef(new Map<string, InteractiveContent>());
    const lastSessionPreferences = useRef('');

    const selectedSession = sessions.find(session => session.id === selectedId) ?? sessions[0];
    const busy = selectedSession ? activeRequestSessions.has(selectedSession.id) : false;
    const attentionCount = sessions.filter(session => Boolean(session.attention)).length;
    const showContext = Boolean(selectedSession && activeSurface.kind === 'session' && contextOpen);
    const canGoBack = navigationIndex > 0;
    const canGoForward = navigationIndex < navigationHistory.length - 1;

    const loadSyncedConversation = async (
        provider: ConversationProvider,
        externalId: string,
        sessionId: string,
        expectedUpdatedAt: string
    ): Promise<void> => {
        setSessions(current => current.map(session => session.id === sessionId ? { ...session, loading: true } : session));
        try {
            const detail = await conversationSyncService.readConversation(provider, externalId);
            if (!detail) {
                throw new Error(`${providerLabels[provider]} conversation ${externalId} is no longer available.`);
            }
            loadedConversationVersions.current.set(sessionId, detail.updatedAt || expectedUpdatedAt);
            setSessions(current => current.map(session => session.id === sessionId ? applyConversationDetail(session, detail) : session));
        } catch (error) {
            console.error(`Failed to load ${providerLabels[provider]} conversation`, error);
            setSessions(current => current.map(session => session.id === sessionId ? { ...session, loading: false } : session));
            setToast(`Could not load the ${providerLabels[provider]} conversation`);
        }
    };

    useEffect(() => {
        selectedIdRef.current = selectedId;
    }, [selectedId]);

    useEffect(() => () => {
        responseDisposablesRef.current.forEach(disposables => disposables.forEach(disposable => disposable.dispose()));
        responseDisposablesRef.current.clear();
    }, []);

    useEffect(() => {
        let disposed = false;
        const refresh = async (): Promise<void> => {
            if (refreshInFlight.current || document.visibilityState === 'hidden') {
                return;
            }
            refreshInFlight.current = true;
            try {
                const snapshot = await conversationSyncService.listConversations();
                if (disposed) {
                    return;
                }
                setConversationSources(current => reconcileConversationSources(current, snapshot.sources));
                setSessions(current => reconcileSyncedSessions(current, snapshot.conversations));

                const selectedSessionId = selectedIdRef.current;
                const selectedSummary = selectedSessionId ? snapshot.conversations.find(summary =>
                    `${summary.provider}:${summary.id}` === selectedSessionId) : undefined;
                if (selectedSummary
                    && loadedConversationVersions.current.get(selectedSessionId!) !== selectedSummary.updatedAt) {
                    await loadSyncedConversation(
                        selectedSummary.provider,
                        selectedSummary.id,
                        selectedSessionId!,
                        selectedSummary.updatedAt
                    );
                }
            } catch (error) {
                console.error('Failed to synchronize external conversations', error);
                if (!disposed) {
                    setToast('External conversation sync is unavailable');
                }
            } finally {
                refreshInFlight.current = false;
            }
        };
        refresh().catch(error => console.error(error));
        const interval = window.setInterval(() => refresh().catch(error => console.error(error)), CONVERSATION_SYNC_INTERVAL_MS);
        return () => {
            disposed = true;
            window.clearInterval(interval);
        };
    }, [conversationSyncService]);

    const refreshView = async (): Promise<void> => {
        if (refreshInFlight.current) {
            return;
        }
        refreshInFlight.current = true;
        setRefreshing(true);
        try {
            const snapshot = await conversationSyncService.listConversations(true);
            setConversationSources(current => reconcileConversationSources(current, snapshot.sources));
            setSessions(current => reconcileSyncedSessions(current, snapshot.conversations));

            const selectedSessionId = selectedIdRef.current;
            const selectedSummary = selectedSessionId ? snapshot.conversations.find(summary =>
                `${summary.provider}:${summary.id}` === selectedSessionId) : undefined;
            if (selectedSummary
                && loadedConversationVersions.current.get(selectedSessionId!) !== selectedSummary.updatedAt) {
                await loadSyncedConversation(
                    selectedSummary.provider,
                    selectedSummary.id,
                    selectedSessionId!,
                    selectedSummary.updatedAt
                );
            }
        } catch (error) {
            console.error('Failed to refresh Agent Focus', error);
            setToast('Could not refresh Agent Focus');
        } finally {
            refreshInFlight.current = false;
            setRefreshing(false);
        }
    };

    useEffect(() => {
        try {
            window.localStorage.setItem('erebus.agentFocus.railCollapsed', String(railCollapsed));
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [railCollapsed]);

    useEffect(() => {
        storeJson(LOCAL_SESSIONS_STORAGE_KEY, sessions.filter(session => session.provider === 'erebus'));
        const serializedPreferences = JSON.stringify(Object.fromEntries(sessions.map(session => [session.id, {
            pinned: Boolean(session.pinned),
            hidden: Boolean(session.hidden),
            tags: session.tags ?? []
        }])));
        if (serializedPreferences !== lastSessionPreferences.current) {
            lastSessionPreferences.current = serializedPreferences;
            try {
                window.localStorage.setItem(SESSION_PREFERENCES_STORAGE_KEY, serializedPreferences);
            } catch {
                // Persistence is optional in restricted browser contexts.
            }
        }
    }, [sessions]);

    useEffect(() => {
        try {
            if (selectedId) {
                window.localStorage.setItem(SELECTED_SESSION_STORAGE_KEY, selectedId);
            } else {
                window.localStorage.removeItem(SELECTED_SESSION_STORAGE_KEY);
            }
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [selectedId]);

    useEffect(() => {
        try {
            window.localStorage.setItem(CONTEXT_OPEN_STORAGE_KEY, String(contextOpen));
            window.localStorage.setItem(CONTEXT_TAB_STORAGE_KEY, contextTab);
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [contextOpen, contextTab]);

    useEffect(() => {
        try {
            window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth));
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [railWidth]);

    useEffect(() => {
        try {
            window.localStorage.setItem(PROJECT_CATEGORIES_STORAGE_KEY, JSON.stringify(categories));
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [categories]);

    useEffect(() => {
        try {
            window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
        } catch {
            // Persistence is optional in restricted browser contexts.
        }
    }, [projects]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ block: 'end' });
    }, [selectedSession?.messages.length, selectedId, busy]);

    useEffect(() => {
        if (!toast) {
            return undefined;
        }
        const timeout = window.setTimeout(() => setToast(undefined), 2400);
        return () => window.clearTimeout(timeout);
    }, [toast]);

    const updateSession = (sessionId: string, update: (session: FocusSession) => FocusSession): void => {
        setSessions(current => current.map(session => session.id === sessionId ? update(session) : session));
    };

    const activateNavigationTarget = (target: NavigationTarget): void => {
        if (target.kind === 'home') {
            selectedIdRef.current = undefined;
            setSelectedId(undefined);
            setActiveSurface(target);
            return;
        }
        if (target.kind !== 'session') {
            setActiveSurface(target);
            return;
        }
        const available = sessions.find(candidate => candidate.id === target.sessionId);
        if (!available) {
            selectedIdRef.current = undefined;
            setSelectedId(undefined);
            setActiveSurface({ kind: 'home' });
            return;
        }
        setActiveSurface(target);
        const sessionId = available.id;
        selectedIdRef.current = sessionId;
        setSelectedId(sessionId);
        setContextTab('context');
        setSelectedChangeFile(available.changedFiles[0]);
        setComposer('');
        if (available.readOnly && available.externalId && available.sourceUpdatedAt
            && loadedConversationVersions.current.get(sessionId) !== available.sourceUpdatedAt) {
            loadSyncedConversation(
                available.provider as ConversationProvider,
                available.externalId,
                sessionId,
                available.sourceUpdatedAt
            ).catch(error => console.error(error));
        }
    };

    const navigateTo = (target: NavigationTarget): void => {
        const current = navigationHistory[navigationIndex];
        const sameTarget = current?.kind === target.kind
            && (current.kind !== 'session' || target.kind === 'session' && current.sessionId === target.sessionId);
        if (sameTarget) {
            activateNavigationTarget(target);
            return;
        }
        setNavigationHistory(history => [...history.slice(0, navigationIndex + 1), target]);
        setNavigationIndex(navigationIndex + 1);
        activateNavigationTarget(target);
    };

    const selectSession = (sessionId: string): void => navigateTo({ kind: 'session', sessionId });

    const goBack = (): void => {
        if (!canGoBack) {
            return;
        }
        const nextIndex = navigationIndex - 1;
        setNavigationIndex(nextIndex);
        activateNavigationTarget(navigationHistory[nextIndex]);
    };

    const goForward = (): void => {
        if (!canGoForward) {
            return;
        }
        const nextIndex = navigationIndex + 1;
        setNavigationIndex(nextIndex);
        activateNavigationTarget(navigationHistory[nextIndex]);
    };

    const openChanges = (): void => {
        if (!selectedSession) {
            return;
        }
        setContextOpen(true);
        setContextTab('changes');
        setSelectedChangeFile(selectedSession.changedFiles[0]);
    };

    const setSessionBusy = (sessionId: string, isBusy: boolean): void => setActiveRequestSessions(current => {
        const next = new Set(current);
        if (isBusy) {
            next.add(sessionId);
        } else {
            next.delete(sessionId);
        }
        return next;
    });

    const changeFilesForChat = (chatSessionId: string): string[] => {
        const chatSession = chatService.getSession(chatSessionId);
        if (!chatSession) {
            return [];
        }
        return chatSession.model.changeSet.getElements().map(element => {
            const path = element.uri.path.toString();
            return path.replace(/^\/([A-Za-z]:)/, '$1');
        });
    };

    const syncResponse = (sessionId: string, chatSessionId: string, messageId: string, agentName: string,
        executionProfile: string, response: ChatResponseModel): void => {
        const changedFiles = changeFilesForChat(chatSessionId);
        const toolDetails: FocusToolCall[] = response.response.content.filter(ToolCallChatResponseContent.is).map((tool, index) => ({
            id: tool.id ?? `${response.id}-tool-${index}`,
            name: tool.name ?? `Tool call ${index + 1}`,
            status: tool.isAwaitingUserConfirmation ? 'approval' : tool.finished ? 'complete' : 'running',
            detail: tool.arguments
        }));
        const toolCalls = toolDetails.length;
        const hasUnresolvedInteraction = response.response.content.some(content => InteractiveContent.is(content) && !content.isResolved);
        const startedAt = activeRequestsRef.current.get(sessionId)?.startedAt;
        const elapsedMilliseconds = startedAt ? Math.max(0, Date.now() - startedAt) : undefined;
        const elapsed = elapsedMilliseconds === undefined ? undefined : elapsedMilliseconds < 60_000
            ? `${Math.max(1, Math.round(elapsedMilliseconds / 1000))}s`
            : `${Math.floor(elapsedMilliseconds / 60_000)}m ${Math.round((elapsedMilliseconds % 60_000) / 1000)}s`;
        const display = response.response.asDisplayString().trim();
        const body = display
            ? [display]
            : response.isError ? [response.errorObject?.message ?? 'The agent request failed.']
                : response.isCanceled ? ['Request stopped.'] : ['Working…'];
        updateSession(sessionId, session => {
            const message: FocusMessage = {
                id: messageId,
                role: 'agent',
                agentName,
                body,
                executionProfile,
                toolCalls: toolCalls || undefined,
                toolDetails: toolDetails.length > 0 ? toolDetails : undefined,
                changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
                elapsed: response.isComplete || response.isCanceled || response.isError ? elapsed : undefined
            };
            const existingIndex = session.messages.findIndex(candidate => candidate.id === messageId);
            const messages = existingIndex < 0
                ? [...session.messages, message]
                : session.messages.map((candidate, index) => index === existingIndex ? message : candidate);
            const hasAttention = Boolean(session.attention && hasUnresolvedInteraction
                && !response.isComplete && !response.isCanceled && !response.isError);
            return {
                ...session,
                messages,
                changedFiles: changedFiles.length > 0 ? Array.from(new Set([...session.changedFiles, ...changedFiles])) : session.changedFiles,
                attention: response.isComplete || response.isCanceled || response.isError || !hasUnresolvedInteraction
                    ? undefined : session.attention,
                status: hasAttention ? 'attention' : response.isComplete ? 'complete' : response.isError || response.isCanceled ? 'paused' : 'working',
                summary: response.isError ? 'Agent request failed' : response.isCanceled ? 'Agent request stopped'
                    : response.isComplete ? `${agentName} completed the latest turn` : `${agentName} is working`,
                updated: 'now'
            };
        });
    };

    const registerInteraction = (sessionId: string, response: ChatResponseModel, content: InteractiveContent): void => {
        const interactionId = content.interactionId ?? `${response.id}-interaction`;
        interactionRefs.current.set(interactionId, content);
        let attention: FocusAttentionRequest | undefined;
        if (ToolCallChatResponseContent.is(content) && content.isAwaitingUserConfirmation) {
            attention = {
                id: interactionId,
                kind: 'tool',
                title: 'Tool approval',
                message: `The agent wants to run ${content.name ?? 'a tool'}.`,
                detail: content.arguments,
                options: [
                    { id: 'deny', label: 'Deny', destructive: true },
                    { id: 'allow', label: 'Allow once', primary: true }
                ]
            };
        } else if (QuestionResponseContent.is(content)) {
            attention = {
                id: interactionId,
                kind: 'question',
                title: content.header ?? 'Agent question',
                message: content.question,
                options: content.options.map((option, index) => ({
                    id: `question:${index}`,
                    label: option.text,
                    description: option.description,
                    primary: index === 0
                }))
            };
        }
        if (!attention) {
            return;
        }
        updateSession(sessionId, session => ({
            ...session,
            attention,
            status: 'attention',
            summary: attention?.kind === 'tool' ? 'Waiting for tool approval' : 'Waiting for your answer',
            updated: 'now'
        }));
    };

    const subscribeToResponse = (sessionId: string, chatSessionId: string, response: ChatResponseModel,
        agentName: string, executionProfile: string): void => {
        const messageId = `${sessionId}-agent-${response.id}`;
        responseDisposablesRef.current.get(messageId)?.forEach(disposable => disposable.dispose());
        const update = (): void => syncResponse(sessionId, chatSessionId, messageId, agentName, executionProfile, response);
        const disposables = [
            response.onDidChange(update),
            response.onInteractionNeeded(content => registerInteraction(sessionId, response, content))
        ];
        responseDisposablesRef.current.set(messageId, disposables);
        update();
        response.response.content.forEach(content => {
            if (InteractiveContent.is(content) && !content.isResolved
                && (!ToolCallChatResponseContent.is(content) || content.isAwaitingUserConfirmation)) {
                registerInteraction(sessionId, response, content);
            }
        });
    };

    const dispatchMessage = async (messageText: string, submission: ComposerSubmission, taskIds: string[] = []): Promise<void> => {
        const trimmed = messageText.trim();
        const targetSession = sessions.find(session => session.id === selectedIdRef.current);
        if (!trimmed || !targetSession || activeRequestsRef.current.has(targetSession.id) || targetSession.readOnly) {
            return;
        }

        const targetId = targetSession.id;
        const selectedAgent = COMPOSER_AGENTS.find(option => option.value === submission.agent) ?? COMPOSER_AGENTS[0];
        const selectedEffort = COMPOSER_EFFORTS.find(option => option.value === submission.effort) ?? COMPOSER_EFFORTS[1];
        const selectedAccess = COMPOSER_ACCESS_MODES.find(option => option.value === submission.access) ?? COMPOSER_ACCESS_MODES[1];
        const userMessage: FocusMessage = {
            id: `${targetId}-user-${Date.now()}`,
            role: 'user',
            body: [trimmed],
            context: submission.context,
            executionParameters: {
                permissions: {
                    mode: submission.access,
                    label: selectedAccess.label
                },
                attachments: submission.context.map(item => ({
                    kind: item.kind,
                    label: item.label,
                    detail: item.detail,
                    paths: item.paths
                })),
                model: {
                    id: submission.agent,
                    label: selectedAgent.label
                },
                reasoningLevel: {
                    id: submission.effort,
                    label: selectedEffort.label
                },
                autopilot: submission.autopilot,
                workspace: targetSession.workspace,
                session: targetSession.title
            }
        };
        updateSession(targetId, session => ({
            ...session,
            status: 'working',
            attention: undefined,
            summary: `${selectedAgent.label} is starting`,
            updated: 'now',
            messages: [...session.messages, userMessage]
        }));
        setComposer('');
        setSessionBusy(targetId, true);

        try {
            const requestedAgent = chatAgentService.getAgent(COMPOSER_AGENT_IDS[submission.agent], true);
            const agent = requestedAgent ?? chatAgentService.getEffectiveDefaultAgent() ?? chatAgentService.getAgents(true)[0];
            if (!agent) {
                throw new Error('No enabled Theia chat agent is available. Configure an AI provider in the full settings editor.');
            }

            let chatSession = targetSession.chatSessionId
                ? await chatService.getOrRestoreSession(targetSession.chatSessionId)
                : undefined;
            if (!chatSession) {
                chatSession = chatService.createSession(ChatAgentLocation.Panel, { focus: false }, agent);
            } else {
                chatSession.pinnedAgent = agent;
            }
            chatSession.title = targetSession.title;
            const model = chatSession.model as MutableChatModel;
            model.setSettings({
                ...model.settings,
                commonSettings: {
                    ...model.settings?.commonSettings,
                    reasoning: { level: COMPOSER_REASONING_LEVELS[submission.effort] }
                }
            });
            updateSession(targetId, session => ({ ...session, chatSessionId: chatSession!.id }));
            toolConfirmationManager.clearSessionOverrides(chatSession.id);
            if (submission.access !== 'custom') {
                toolInvocationRegistry.getAllFunctions().forEach(tool => {
                    const mode = submission.access === 'ask'
                        ? ToolConfirmationMode.CONFIRM
                        : submission.access === 'approve' && tool.confirmAlwaysAllow
                            ? ToolConfirmationMode.CONFIRM
                            : ToolConfirmationMode.ALWAYS_ALLOW;
                    toolConfirmationManager.setSessionConfirmationMode(tool.id, mode, chatSession!.id);
                });
            }
            activeRequestsRef.current.set(targetId, {
                chatSessionId: chatSession.id,
                requestId: '',
                taskIds,
                startedAt: Date.now()
            });

            const attachedContext = submission.context.flatMap(item => item.paths?.length
                ? item.paths.map(path => `${item.kind}: ${path}`)
                : [`${item.kind}: ${item.label}${item.detail ? ` (${item.detail})` : ''}`]);
            const policy = submission.access === 'ask' ? 'Ask before using tools that mutate files or external state.'
                : submission.access === 'full' ? 'Use available tools autonomously within the current workspace and configured safety policy.'
                    : submission.access === 'custom' ? 'Follow the tool and permission policy configured for this application.'
                        : 'Proceed autonomously for safe actions and pause for potentially unsafe actions.';
            const requestText = [trimmed, `Agent Focus execution policy: ${policy}`,
                attachedContext.length > 0 ? `Attached context:\n${attachedContext.map(item => `- ${item}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
            const invocation = await chatService.sendRequest(chatSession.id, {
                text: requestText,
                displayText: trimmed,
                modeId: submission.agent === 'erebus'
                    ? submission.autopilot ? 'coder-system-agent-mode-next' : 'coder-system-edit'
                    : undefined
            });
            if (!invocation) {
                throw new Error('The agent session could not accept the request.');
            }
            const request = await invocation.requestCompleted;
            const activeRequest = activeRequestsRef.current.get(targetId);
            if (activeRequest) {
                activeRequest.requestId = request.id;
                if (activeRequest.cancelRequested) {
                    await chatService.cancelRequest(chatSession.id, request.id);
                }
            }
            const response = await invocation.responseCreated;
            subscribeToResponse(targetId, chatSession.id, response, agent.name, `${selectedEffort.label} · ${selectedAccess.label}`);
            const completed = await invocation.responseCompleted;
            const responseMessageId = `${targetId}-agent-${completed.id}`;
            syncResponse(targetId, chatSession.id, responseMessageId, agent.name,
                `${selectedEffort.label} · ${selectedAccess.label}`, completed);
            responseDisposablesRef.current.get(responseMessageId)?.forEach(disposable => disposable.dispose());
            responseDisposablesRef.current.delete(responseMessageId);
            if (taskIds.length > 0 && completed.isComplete && !completed.isError && !completed.isCanceled) {
                updateSession(targetId, session => ({
                    ...session,
                    tasks: session.tasks.map(task => taskIds.includes(task.id)
                        ? { ...task, awaitingReview: true }
                        : task)
                }));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Agent Focus request failed', error);
            updateSession(targetId, session => ({
                ...session,
                status: 'paused',
                summary: 'Agent request failed',
                messages: [...session.messages, {
                    id: `${targetId}-agent-error-${Date.now()}`,
                    role: 'agent',
                    agentName: selectedAgent.label,
                    body: [message]
                }]
            }));
            setToast(message);
        } finally {
            activeRequestsRef.current.delete(targetId);
            setSessionBusy(targetId, false);
        }
    };

    const submitMessage = (submission: ComposerSubmission): void => {
        dispatchMessage(composer, submission).catch(error => console.error(error));
    };

    const cancelRequest = (): void => {
        if (!selectedSession) {
            return;
        }
        const request = activeRequestsRef.current.get(selectedSession.id);
        if (!request) {
            return;
        }
        if (!request.requestId) {
            request.cancelRequested = true;
            setToast('Stop requested');
            return;
        }
        chatService.cancelRequest(request.chatSessionId, request.requestId).catch(error => {
            console.error('Failed to stop Agent Focus request', error);
            setToast('Could not stop the active request');
        });
    };

    const createSession = (input: NewSessionInput): void => {
        const id = `session-${Date.now()}`;
        const title = input.workflow ? `${input.workflow} — Untitled task` : 'Untitled agent session';
        const template = input.workflow ? WORKFLOW_TEMPLATES[input.workflow] : undefined;
        const session: FocusSession = {
            id,
            provider: 'erebus',
            workspace: input.workspace,
            title,
            summary: input.workflow ? `${input.workflow} workflow ready` : 'Ready for a new direction',
            updated: 'now',
            status: 'paused',
            kind: 'local',
            monogram: input.workflow ? input.workflow.split(' ').map(word => word[0]).join('').slice(0, 2) : 'NS',
            accent: '#9b6cff',
            messages: [],
            workflow: input.workflow,
            requirement: template?.requirement ?? 'Describe the outcome you want the agent to own.',
            designNotes: template?.designNotes ?? ['Keep the scope explicit', 'Surface blocking decisions', 'Verify the final result'],
            tasks: template?.tasks.map((task, index) => ({
                id: `${id}-task-${index + 1}`,
                label: task.label,
                prompt: task.prompt,
                complete: false
            })) ?? [],
            changedFiles: []
        };
        setSessions(current => [session, ...current]);
        selectedIdRef.current = id;
        setSelectedId(id);
        setActiveSurface({ kind: 'session', sessionId: id });
        setNavigationHistory(history => [...history.slice(0, navigationIndex + 1), { kind: 'session', sessionId: id }]);
        setNavigationIndex(navigationIndex + 1);
        setNewSessionOpen(false);
        setContextTab('context');
        setSelectedChangeFile(undefined);
        setComposer(template?.starter ?? '');
    };

    const assignProjectToCategory = (categoryId: string, project: string): void => {
        setCategories(current => current.map(category => ({
            ...category,
            projects: category.id === categoryId && categoryId !== UNCATEGORIZED_CATEGORY_ID
                ? [...category.projects.filter(candidate => candidate !== project), project]
                : category.projects.filter(candidate => candidate !== project)
        })));
        const categoryName = categoryId === UNCATEGORIZED_CATEGORY_ID
            ? UNCATEGORIZED_CATEGORY_NAME
            : categories.find(category => category.id === categoryId)?.name;
        setToast(categoryName ? `${project} moved to ${categoryName}` : `${project} moved`);
    };

    const createProject = (input: NewProjectInput): void => {
        const project: ProjectDefinition = {
            id: `project-${Date.now()}`,
            name: input.name,
            kind: input.kind,
            sourceFolders: input.sourceFolders,
            tags: [],
            hidden: false
        };
        setProjects(current => [...current, project]);
        setCategories(current => current.map(category => ({
            ...category,
            projects: category.projects.filter(candidate => candidate !== project.name)
        })));
        setNewProjectOpen(false);
        setToast(`${project.name} created in ${UNCATEGORIZED_CATEGORY_NAME}`);
    };

    const createCategory = (name: string): void => {
        const project = categoryDialog?.project;
        setCategories(current => [
            ...current.map(category => ({
                ...category,
                projects: project ? category.projects.filter(candidate => candidate !== project) : category.projects
            })),
            {
                id: `category-${Date.now()}`,
                name,
                projects: project ? [project] : []
            }
        ]);
        setCategoryDialog(undefined);
        setToast(project ? `${project} moved to ${name}` : `${name} category created`);
    };

    const resolveAttention = (sessionId: string, optionId: string): void => {
        const session = sessions.find(candidate => candidate.id === sessionId);
        const attention = session?.attention;
        const interaction = attention ? interactionRefs.current.get(attention.id) : undefined;
        if (!attention || !interaction) {
            updateSession(sessionId, currentSession => ({
                ...currentSession,
                attention: undefined,
                status: 'paused',
                summary: 'The approval request expired',
                updated: 'now'
            }));
            setToast('That request is no longer active');
            return;
        }
        let resolved = false;
        if (ToolCallChatResponseContent.is(interaction)) {
            if (optionId === 'allow') {
                interaction.confirm();
            } else {
                interaction.deny('Denied from Agent Focus');
            }
            resolved = true;
        } else if (QuestionResponseContent.is(interaction)) {
            const optionIndex = Number(optionId.replace('question:', ''));
            const option = interaction.options[optionIndex];
            if (option && interaction.handler) {
                if (interaction.multiSelect) {
                    (interaction.handler as (value: Array<{ text: string; value?: string }>) => void)([option]);
                } else {
                    (interaction.handler as (value: typeof option) => void)(option);
                }
                resolved = true;
            }
        }
        if (!resolved) {
            setToast('Choose one of the available responses');
            return;
        }
        interactionRefs.current.delete(attention.id);
        updateSession(sessionId, currentSession => ({
            ...currentSession,
            attention: undefined,
            status: 'working',
            summary: optionId === 'deny' ? 'Continuing without the denied tool' : 'Agent is continuing',
            updated: 'now'
        }));
        setToast(optionId === 'deny' ? 'Request denied' : 'Response sent to the agent');
    };

    const runRemainingTasks = (): void => {
        if (!selectedSession) {
            return;
        }
        const pending = selectedSession.tasks.filter(task => !task.complete);
        if (pending.length === 0) {
            return;
        }
        const submission: ComposerSubmission = {
            agent: loadComposerPreference(COMPOSER_AGENT_STORAGE_KEY, COMPOSER_AGENTS, 'erebus'),
            effort: loadComposerPreference(COMPOSER_EFFORT_STORAGE_KEY, COMPOSER_EFFORTS, 'balanced'),
            access: loadComposerPreference(COMPOSER_ACCESS_STORAGE_KEY, COMPOSER_ACCESS_MODES, 'approve'),
            autopilot: loadComposerAutopilot(),
            context: []
        };
        updateSession(selectedSession.id, session => ({
            ...session,
            tasks: session.tasks.map(task => pending.some(candidate => candidate.id === task.id)
                ? { ...task, awaitingReview: false }
                : task)
        }));
        dispatchMessage(`Execute the remaining workflow tasks:\n${pending.map(task => `- ${task.label}: ${task.prompt ?? task.label}`).join('\n')}`, submission,
            pending.map(task => task.id)).catch(error => console.error(error));
    };

    const runTask = (taskId: string): void => {
        if (!selectedSession) {
            return;
        }
        const task = selectedSession.tasks.find(candidate => candidate.id === taskId);
        if (!task || task.complete) {
            return;
        }
        const submission: ComposerSubmission = {
            agent: loadComposerPreference(COMPOSER_AGENT_STORAGE_KEY, COMPOSER_AGENTS, 'erebus'),
            effort: loadComposerPreference(COMPOSER_EFFORT_STORAGE_KEY, COMPOSER_EFFORTS, 'balanced'),
            access: loadComposerPreference(COMPOSER_ACCESS_STORAGE_KEY, COMPOSER_ACCESS_MODES, 'approve'),
            autopilot: loadComposerAutopilot(),
            context: []
        };
        updateSession(selectedSession.id, session => ({
            ...session,
            tasks: session.tasks.map(candidate => candidate.id === task.id ? { ...candidate, awaitingReview: false } : candidate)
        }));
        dispatchMessage(`Execute this workflow task and verify the result: ${task.prompt ?? task.label}`, submission, [task.id])
            .catch(error => console.error(error));
    };

    const setTaskComplete = (taskId: string, complete: boolean): void => {
        if (!selectedSession) {
            return;
        }
        updateSession(selectedSession.id, session => ({
            ...session,
            tasks: session.tasks.map(task => task.id === taskId
                ? { ...task, complete, awaitingReview: complete ? false : task.awaitingReview }
                : task)
        }));
    };

    const findChangeElement = async (session: FocusSession, file: string) => {
        const chatSession = session.chatSessionId
            ? chatService.getSession(session.chatSessionId) ?? await chatService.getOrRestoreSession(session.chatSessionId)
            : undefined;
        const normalizedFile = file.replace(/\\/g, '/').toLocaleLowerCase();
        return chatSession?.model.changeSet.getElements().find(element => {
            const candidate = element.uri.path.toString().replace(/\\/g, '/').toLocaleLowerCase();
            return candidate === normalizedFile || candidate.endsWith(`/${normalizedFile}`) || normalizedFile.endsWith(`/${candidate}`);
        });
    };

    const openChange = async (file: string): Promise<void> => {
        if (!selectedSession) {
            return;
        }
        const element = await findChangeElement(selectedSession, file);
        if (element?.openChange) {
            element.openChange().catch(error => {
                console.error('Failed to open change', error);
                setToast(`Could not open ${file}`);
            });
        } else if (element?.open) {
            element.open().catch(error => {
                console.error('Failed to open changed file', error);
                setToast(`Could not open ${file}`);
            });
        } else {
            setToast(`No live diff is available for ${file}`);
        }
    };

    const reviewChange = async (file: string, state: 'accepted' | 'rejected'): Promise<void> => {
        if (!selectedSession) {
            return;
        }
        const element = await findChangeElement(selectedSession, file);
        if (!element) {
            setToast(`No live diff is available for ${file}`);
            return;
        }
        const operation = state === 'accepted' ? element?.apply?.() : element?.revert?.();
        const complete = (): void => {
            updateSession(selectedSession.id, session => ({
                ...session,
                changeReviews: { ...session.changeReviews, [file]: state }
            }));
            setToast(`${file} ${state}`);
        };
        if (operation) {
            operation.then(complete).catch((error: unknown) => {
                console.error(`Failed to ${state} change`, error);
                setToast(`Could not ${state === 'accepted' ? 'accept' : 'reject'} ${file}`);
            });
        } else {
            setToast(`This change cannot be ${state === 'accepted' ? 'accepted' : 'rejected'} from Agent Focus`);
        }
    };

    const commentOnChange = (file: string): void => {
        setComposer(`Review ${file} and address this feedback: `);
        setContextOpen(false);
        setToast('Comment added to the composer');
    };

    const togglePin = (sessionId: string): void => updateSession(sessionId, session => ({ ...session, pinned: !session.pinned }));
    const toggleHidden = (sessionId: string): void => updateSession(sessionId, session => ({ ...session, hidden: !session.hidden }));
    const renameSession = (sessionId: string): void => {
        const session = sessions.find(candidate => candidate.id === sessionId);
        if (!session) {
            return;
        }
        const title = window.prompt('Rename session', session.title)?.trim();
        if (!title || title === session.title) {
            return;
        }
        updateSession(sessionId, candidate => ({ ...candidate, title }));
        if (session.chatSessionId) {
            chatService.renameSession(session.chatSessionId, title).catch(error => console.error('Failed to rename backing chat session', error));
        }
    };
    const removeSession = (sessionId: string): void => {
        const session = sessions.find(candidate => candidate.id === sessionId);
        if (!session || session.provider !== 'erebus' || !window.confirm(`Remove "${session.title}"?`)) {
            return;
        }
        if (activeRequestsRef.current.has(sessionId)) {
            setToast('Stop the active request before removing this session');
            return;
        }
        const remaining = sessions.filter(candidate => candidate.id !== sessionId);
        setSessions(remaining);
        if (session.chatSessionId) {
            toolConfirmationManager.clearSessionOverrides(session.chatSessionId);
            chatService.deleteSession(session.chatSessionId).catch(error => console.error('Failed to delete backing chat session', error));
        }
        if (selectedId === sessionId && remaining.length > 0) {
            navigateTo({ kind: 'session', sessionId: remaining[0].id });
        } else if (selectedId === sessionId) {
            navigateTo({ kind: 'home' });
        }
        setToast('Session removed');
    };

    const resizeRail = (width: number): void => {
        if (railCollapsed) {
            if (width > 84) {
                setRailCollapsed(false);
                setRailWidth(MIN_RAIL_WIDTH);
            }
            return;
        }
        if (width < RAIL_COLLAPSE_THRESHOLD) {
            setRailCollapsed(true);
        } else {
            setRailWidth(clampRailWidth(width));
        }
    };

    useEffect(() => {
        const handleNavigationShortcut = (event: KeyboardEvent): void => {
            if (!(event.ctrlKey || event.metaKey) || (event.key !== '[' && event.key !== ']')) {
                return;
            }
            event.preventDefault();
            if (event.key === '[') {
                goBack();
            } else {
                goForward();
            }
        };
        window.addEventListener('keydown', handleNavigationShortcut);
        return () => window.removeEventListener('keydown', handleNavigationShortcut);
    });

    const checkForUpdates = (): void => {
        setCheckingForUpdates(true);
        Promise.resolve(onCheckForUpdates()).then(() => setToast('Update check started')).catch(error => {
            console.error('Update check failed', error);
            setToast('Could not check for updates');
        }).finally(() => setCheckingForUpdates(false));
    };

    const workspaceOptions = Array.from(new Set([
        'Erebus',
        ...projects.map(project => project.name),
        ...sessions.filter(session => session.provider === 'erebus').map(session => session.workspace)
    ])).sort((left, right) => left.localeCompare(right));

    return <div
        className={`erebus-focus-root${railCollapsed ? ' rail-collapsed' : ''}${showContext ? ' context-open' : ''}`}
        style={{ '--erebus-rail-width': `${railWidth}px` } as React.CSSProperties}
    >
        <TopBar
            title={activeSurface.kind === 'settings' ? 'Settings' : selectedSession?.title ?? 'Agent Focus'}
            subtitle={activeSurface.kind === 'settings' ? 'Agent Focus' : selectedSession?.workspace ?? 'Ready'}
            railCollapsed={railCollapsed}
            contextOpen={contextOpen}
            attentionCount={attentionCount}
            refreshing={refreshing}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onToggleRail={() => setRailCollapsed(current => !current)}
            onBack={goBack}
            onForward={goForward}
            onRefresh={() => refreshView().catch(error => console.error(error))}
            onToggleContext={() => setContextOpen(current => !current)}
            onToggleAttention={() => setAttentionOpen(current => !current)}
            onExitFocusMode={onExitFocusMode}
        />

        <div className='erebus-focus-workspace'>
            <SessionRail
                sessions={sessions}
                projects={projects}
                categories={categories}
                sources={conversationSources}
                selectedId={selectedSession?.id}
                collapsed={railCollapsed}
                onSelect={selectSession}
                onNewSession={() => setNewSessionOpen(true)}
                onNewProject={() => setNewProjectOpen(true)}
                onCreateCategory={project => setCategoryDialog({ project })}
                onAssignProject={assignProjectToCategory}
                onTogglePin={togglePin}
                onRenameSession={renameSession}
                onToggleHidden={toggleHidden}
                onRemoveSession={removeSession}
                onOpenSettings={() => navigateTo({ kind: 'settings' })}
            />

            <RailResizeHandle width={railWidth} collapsed={railCollapsed} onResize={resizeRail} />

            {activeSurface.kind === 'settings' ? <SettingsPanel
                railCollapsed={railCollapsed}
                contextOpen={contextOpen}
                sources={conversationSources}
                checkingForUpdates={checkingForUpdates}
                onToggleRail={() => setRailCollapsed(current => !current)}
                onToggleContext={() => setContextOpen(current => !current)}
                onCheckForUpdates={checkForUpdates}
                onOpenFullSettings={onOpenFullSettings}
            /> : !selectedSession ? <WelcomePanel
                onNewSession={() => setNewSessionOpen(true)}
                onNewProject={() => setNewProjectOpen(true)}
            /> : <main className='erebus-chat-panel'>
                <div className='erebus-chat-scroll'>
                    <div className='erebus-chat-column'>
                        {selectedSession.messages.length === 0 ? <EmptyConversation session={selectedSession} /> : selectedSession.messages.map(message => <ConversationMessage
                            key={message.id}
                            message={message}
                            agentName={selectedSession.provider === 'erebus'
                                ? 'Erebus'
                                : providerLabels[selectedSession.provider as ConversationProvider]}
                            expanded={expandedTools.has(message.id)}
                            onToggleTools={() => setExpandedTools(current => {
                                const next = new Set(current);
                                if (next.has(message.id)) {
                                    next.delete(message.id);
                                } else {
                                    next.add(message.id);
                                }
                                return next;
                            })}
                            onOpenChanges={openChanges}
                        />)}
                        {Boolean(selectedSession.truncatedMessages) && <div className='erebus-history-truncated'>
                            Showing the latest {selectedSession.messages.length} messages. {selectedSession.truncatedMessages} earlier messages remain in the source conversation.
                        </div>}
                        {selectedSession.loading && <div className='erebus-agent-working'>
                            <AgentMark small />
                            <span>Synchronizing {providerLabels[selectedSession.provider as ConversationProvider]}</span>
                            <span className='erebus-working-dots'><i /><i /><i /></span>
                        </div>}
                        {busy && <div className='erebus-agent-working'>
                            <AgentMark small />
                            <span>Erebus is working</span>
                            <span className='erebus-working-dots'><i /><i /><i /></span>
                        </div>}
                        <div ref={element => chatEndRef.current = element ?? undefined} />
                    </div>
                </div>
                <Composer
                    key={selectedSession.id}
                    value={composer}
                    busy={busy}
                    readOnly={Boolean(selectedSession.readOnly)}
                    providerName={selectedSession.provider === 'erebus'
                        ? undefined
                        : providerLabels[selectedSession.provider as ConversationProvider]}
                    workspace={selectedSession.workspace}
                    sessionTitle={selectedSession.title}
                    onChange={setComposer}
                    onSubmit={submitMessage}
                    onCancel={cancelRequest}
                />
            </main>}

            {showContext && <ContextPanel
                session={selectedSession}
                busy={busy}
                tab={contextTab}
                selectedFile={selectedChangeFile}
                onTabChange={setContextTab}
                onClose={() => setContextOpen(false)}
                onRunTasks={runRemainingTasks}
                onRunTask={runTask}
                onSetTaskComplete={setTaskComplete}
                onSelectFile={setSelectedChangeFile}
                onOpenChange={file => openChange(file).catch(error => {
                    console.error('Failed to open change', error);
                    setToast(`Could not open ${file}`);
                })}
                onReviewChange={(file, state) => reviewChange(file, state).catch(error => {
                    console.error(`Failed to ${state} change`, error);
                    setToast(`Could not ${state === 'accepted' ? 'accept' : 'reject'} ${file}`);
                })}
                onCommentOnChange={commentOnChange}
            />}

            {attentionOpen && <AttentionPanel
                sessions={sessions}
                onSelect={selectSession}
                onClose={() => setAttentionOpen(false)}
                onResolve={resolveAttention}
            />}
        </div>

        {newSessionOpen && <NewSessionDialog workspaces={workspaceOptions} onClose={() => setNewSessionOpen(false)} onCreate={createSession} />}
        {newProjectOpen && <NewProjectDialog
            projectNames={Array.from(new Set([
                ...projects.map(project => project.name),
                ...sessions.filter(session => session.provider === 'erebus').map(session => session.workspace)
            ]))}
            onClose={() => setNewProjectOpen(false)}
            onCreate={createProject}
        />}
        {categoryDialog && <NewCategoryDialog
            project={categoryDialog.project}
            categoryNames={[...categories.map(category => category.name), UNCATEGORIZED_CATEGORY_NAME]}
            onClose={() => setCategoryDialog(undefined)}
            onCreate={createCategory}
        />}
        {toast && <div className='erebus-toast' role='status'><Icon name='codicon-check' />{toast}</div>}
    </div>;
}
