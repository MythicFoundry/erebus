/********************************************************************************
 * Copyright (C) 2026 Fromanium.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type SessionStatus = 'working' | 'attention' | 'paused' | 'complete';

export type SessionKind = 'local' | 'cloud' | 'cli';

export type SessionProvider = 'erebus' | 'claude' | 'codex' | 'kiro';

export type MessageRole = 'user' | 'agent';

export type FocusContextKind = 'file' | 'folder' | 'workspace' | 'session';

export interface FocusContextItem {
    id: string;
    kind: FocusContextKind;
    label: string;
    detail?: string;
    paths?: string[];
}

export interface FocusExecutionParameters {
    permissions: {
        mode: string;
        label: string;
    };
    attachments: Array<{
        kind: FocusContextKind;
        label: string;
        detail?: string;
        paths?: string[];
    }>;
    model: {
        id: string;
        label: string;
    };
    reasoningLevel: {
        id: string;
        label: string;
    };
    autopilot: boolean;
    workspace: string;
    session: string;
}

export interface FocusMessage {
    id: string;
    role: MessageRole;
    body: string[];
    context?: FocusContextItem[];
    executionParameters?: FocusExecutionParameters;
    agentName?: string;
    executionProfile?: string;
    toolCalls?: number;
    toolDetails?: FocusToolCall[];
    changedFiles?: string[];
    elapsed?: string;
}

export type FocusToolCallStatus = 'approval' | 'running' | 'complete';

export interface FocusToolCall {
    id: string;
    name: string;
    status: FocusToolCallStatus;
    detail?: string;
}

export interface SpecTask {
    id: string;
    label: string;
    complete: boolean;
    prompt?: string;
    awaitingReview?: boolean;
}

export type ChangeReviewState = 'pending' | 'accepted' | 'rejected';

export interface FocusAttentionOption {
    id: string;
    label: string;
    description?: string;
    primary?: boolean;
    destructive?: boolean;
}

export interface FocusAttentionRequest {
    id: string;
    kind: 'tool' | 'question';
    title: string;
    message: string;
    detail?: string;
    options: FocusAttentionOption[];
    timedOut?: boolean;
}

export interface FocusSession {
    id: string;
    provider: SessionProvider;
    externalId?: string;
    workspace: string;
    title: string;
    summary: string;
    updated: string;
    status: SessionStatus;
    kind: SessionKind;
    monogram: string;
    accent: string;
    messages: FocusMessage[];
    requirement: string;
    designNotes: string[];
    tasks: SpecTask[];
    changedFiles: string[];
    chatSessionId?: string;
    pinned?: boolean;
    attention?: FocusAttentionRequest;
    changeReviews?: Record<string, ChangeReviewState>;
    sourceUpdatedAt?: string;
    readOnly?: boolean;
    loading?: boolean;
    truncatedMessages?: number;
    tags?: string[];
    hidden?: boolean;
    workflow?: WorkflowKind;
}

export type WorkflowKind = 'Spec' | 'Plan' | 'Bug Fix' | 'Quick Spec';
