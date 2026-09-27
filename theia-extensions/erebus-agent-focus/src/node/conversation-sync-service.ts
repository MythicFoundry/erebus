/********************************************************************************
 * Copyright (C) 2026 Fromanium.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { createInterface } from 'readline';
import { injectable } from '@theia/core/shared/inversify';
import {
    ConversationProvider,
    ConversationSourceStatus,
    ConversationSyncService,
    ConversationSyncSnapshot,
    SyncedConversationDetail,
    SyncedConversationMessage,
    SyncedConversationSummary
} from '../common/conversation-sync-protocol';

const UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MAX_RENDERED_MESSAGES = 1000;
const ACTIVE_FILE_WINDOW_MS = 30_000;
const SUMMARY_READ_CONCURRENCY = 32;
const SNAPSHOT_CACHE_MS = 5_000;

interface ConversationLocator {
    provider: ConversationProvider;
    kind: 'jsonl' | 'sqlite';
    path: string;
    table?: string;
    rowId?: string;
    summary: SyncedConversationSummary;
}

interface CodexIndexEntry {
    id: string;
    thread_name?: string;
    updated_at?: string;
}

interface ClaudeConversationCandidate {
    file: string;
    summary: SyncedConversationSummary;
}

interface ClaudeConversationMetadata {
    cwd?: string;
    firstUserMessage?: string;
    sessionId?: string;
}

interface SqliteStatement {
    all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): void;
    close(): void;
}

interface SqliteDatabaseConstructor {
    new(path: string, options?: { readOnly?: boolean }): SqliteDatabase;
}

interface NodeSqliteModule {
    DatabaseSync: SqliteDatabaseConstructor;
}

@injectable()
export class ConversationSyncServiceImpl implements ConversationSyncService {
    protected readonly claudeRoot = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
    protected readonly codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    protected readonly kiroRoot = resolve(process.env.KIRO_HOME || join(homedir(), '.kiro'));
    protected readonly locators = new Map<string, ConversationLocator>();
    protected cachedSnapshot: ConversationSyncSnapshot | undefined;
    protected cachedSnapshotAt = 0;

    async listConversations(force = false): Promise<ConversationSyncSnapshot> {
        if (process.env.EREBUS_E2E === '1') {
            return {
                conversations: [],
                sources: (['claude', 'codex', 'kiro'] as ConversationProvider[]).map(provider => ({
                    provider,
                    available: false,
                    conversationCount: 0,
                    message: 'External conversation discovery is disabled for E2E tests.'
                }))
            };
        }
        if (!force && this.cachedSnapshot && Date.now() - this.cachedSnapshotAt < SNAPSHOT_CACHE_MS) {
            return this.cachedSnapshot;
        }
        this.locators.clear();
        const [claude, codex, kiro] = await Promise.all([
            this.listClaudeConversations(),
            this.listCodexConversations(),
            this.listKiroConversations()
        ]);
        const conversations = [...claude.conversations, ...codex.conversations, ...kiro.conversations]
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        this.cachedSnapshot = {
            conversations,
            sources: [claude.status, codex.status, kiro.status]
        };
        this.cachedSnapshotAt = Date.now();
        return this.cachedSnapshot;
    }

    async readConversation(provider: ConversationProvider, id: string): Promise<SyncedConversationDetail | undefined> {
        if (!this.isSafeConversationId(id)) {
            return undefined;
        }
        let locator = this.locators.get(this.locatorKey(provider, id));
        if (!locator) {
            await this.listConversations();
            locator = this.locators.get(this.locatorKey(provider, id));
        }
        if (!locator) {
            return undefined;
        }
        if (locator.kind === 'sqlite') {
            return this.readKiroSqliteConversation(locator);
        }
        if (provider === 'claude') {
            return this.readClaudeConversation(locator);
        }
        return provider === 'codex' ? this.readCodexConversation(locator) : this.readKiroJsonlConversation(locator);
    }

    protected async listClaudeConversations(): Promise<{ conversations: SyncedConversationSummary[]; status: ConversationSourceStatus }> {
        const projectsRoot = join(this.claudeRoot, 'projects');
        if (!await this.pathExists(projectsRoot)) {
            return this.unavailableResult('claude', 'No ~/.claude conversation store found.');
        }
        try {
            const files = await this.findFiles([projectsRoot], file => {
                const relativePath = relative(projectsRoot, file);
                return file.endsWith('.jsonl')
                    && UUID_PATTERN.test(basename(file))
                    && !relativePath.split(/[\\/]/).includes('subagents');
            });
            const candidates = (await this.mapConcurrent(files, SUMMARY_READ_CONCURRENCY, async file => {
                const [metadata, stat] = await Promise.all([this.readClaudeMetadata(file), fs.stat(file)]);
                const id = metadata.sessionId || basename(file, '.jsonl');
                if (!this.isSafeConversationId(id)) {
                    return undefined;
                }
                const workspace = await this.resolveClaudeWorkspace(metadata.cwd);
                const summary: SyncedConversationSummary = {
                    id,
                    provider: 'claude',
                    title: this.titleFromText(metadata.firstUserMessage,
                        workspace === 'Uncategorized' ? 'Claude conversation' : `${workspace} conversation`),
                    workspace,
                    cwd: metadata.cwd,
                    updatedAt: stat.mtime.toISOString(),
                    active: Date.now() - stat.mtimeMs < ACTIVE_FILE_WINDOW_MS
                };
                return { file, summary };
            })).filter((candidate): candidate is ClaudeConversationCandidate => Boolean(candidate));

            const latestById = new Map<string, ClaudeConversationCandidate>();
            candidates.forEach(candidate => {
                const existing = latestById.get(candidate.summary.id);
                if (!existing || Date.parse(candidate.summary.updatedAt) > Date.parse(existing.summary.updatedAt)) {
                    latestById.set(candidate.summary.id, candidate);
                }
            });
            const conversations = [...latestById.values()].map(candidate => {
                this.locators.set(this.locatorKey('claude', candidate.summary.id), {
                    provider: 'claude',
                    kind: 'jsonl',
                    path: candidate.file,
                    summary: candidate.summary
                });
                return candidate.summary;
            });
            return {
                conversations,
                status: { provider: 'claude', available: true, conversationCount: conversations.length }
            };
        } catch (error) {
            return this.unavailableResult('claude', this.errorMessage(error));
        }
    }

    protected async listCodexConversations(): Promise<{ conversations: SyncedConversationSummary[]; status: ConversationSourceStatus }> {
        if (!await this.pathExists(this.codexRoot)) {
            return this.unavailableResult('codex', 'No ~/.codex directory found.');
        }
        try {
            const indexPath = join(this.codexRoot, 'session_index.jsonl');
            const entries = await this.readJsonLines<CodexIndexEntry>(indexPath, candidate => {
                const id = this.stringValue(candidate.id);
                return id ? {
                    id,
                    thread_name: this.stringValue(candidate.thread_name),
                    updated_at: this.stringValue(candidate.updated_at)
                } : undefined;
            });
            const rolloutFiles = await this.findFiles(
                [join(this.codexRoot, 'sessions'), join(this.codexRoot, 'archived_sessions')],
                file => basename(file).startsWith('rollout-') && file.endsWith('.jsonl')
            );
            const filesById = new Map<string, string>();
            rolloutFiles.forEach(file => {
                const id = basename(file).match(UUID_PATTERN)?.[1];
                if (id) {
                    filesById.set(id, file);
                }
            });

            const indexById = new Map(entries.map(entry => [entry.id, entry]));
            filesById.forEach((_file, id) => {
                if (!indexById.has(id)) {
                    indexById.set(id, { id });
                }
            });

            const conversations = (await this.mapConcurrent([...indexById.values()], SUMMARY_READ_CONCURRENCY, async entry => {
                const file = filesById.get(entry.id);
                if (!file) {
                    return undefined;
                }
                const [metadata, stat] = await Promise.all([this.readCodexMetadata(file), fs.stat(file)]);
                const cwd = this.firstString(metadata, ['cwd']);
                const workspace = await this.resolveCodexWorkspace(cwd);
                const indexedTimestamp = entry.updated_at ? Date.parse(entry.updated_at) : 0;
                const updatedAt = new Date(Math.max(
                    Number.isNaN(indexedTimestamp) ? 0 : indexedTimestamp,
                    stat.mtimeMs
                )).toISOString();
                const summary: SyncedConversationSummary = {
                    id: entry.id,
                    provider: 'codex',
                    title: this.cleanTitle(entry.thread_name)
                        || (workspace === 'Uncategorized' ? 'Codex conversation' : `${workspace} conversation`),
                    workspace,
                    cwd,
                    updatedAt,
                    active: Date.now() - stat.mtimeMs < ACTIVE_FILE_WINDOW_MS
                };
                this.locators.set(this.locatorKey('codex', entry.id), {
                    provider: 'codex',
                    kind: 'jsonl',
                    path: file,
                    summary
                });
                return summary;
            })).filter((summary): summary is SyncedConversationSummary => Boolean(summary));
            return {
                conversations,
                status: { provider: 'codex', available: true, conversationCount: conversations.length }
            };
        } catch (error) {
            return this.unavailableResult('codex', this.errorMessage(error));
        }
    }

    protected async listKiroConversations(): Promise<{ conversations: SyncedConversationSummary[]; status: ConversationSourceStatus }> {
        const conversations: SyncedConversationSummary[] = [];
        const errors: string[] = [];
        if (await this.pathExists(this.kiroRoot)) {
            try {
                conversations.push(...await this.listKiroJsonlConversations());
            } catch (error) {
                errors.push(this.errorMessage(error));
            }
        }
        for (const databasePath of await this.findKiroDatabaseCandidates()) {
            try {
                conversations.push(...await this.listKiroSqliteConversations(databasePath));
            } catch (error) {
                errors.push(this.errorMessage(error));
            }
        }

        const unique = new Map<string, SyncedConversationSummary>();
        conversations.forEach(conversation => {
            const key = this.locatorKey('kiro', conversation.id);
            const existing = unique.get(key);
            if (!existing || Date.parse(conversation.updatedAt) > Date.parse(existing.updatedAt)) {
                unique.set(key, conversation);
            }
        });
        const result = [...unique.values()];
        const available = await this.pathExists(this.kiroRoot) || result.length > 0;
        return {
            conversations: result,
            status: {
                provider: 'kiro',
                available,
                conversationCount: result.length,
                message: errors.length > 0 ? errors[0] : available ? undefined : 'No ~/.kiro conversation store found.'
            }
        };
    }

    protected async listKiroJsonlConversations(): Promise<SyncedConversationSummary[]> {
        const sessionRoot = join(this.kiroRoot, 'sessions');
        const files = await this.findFiles([sessionRoot], file => basename(file) === 'messages.jsonl');
        const conversations = await this.mapConcurrent(files, SUMMARY_READ_CONCURRENCY, async file => {
            const stat = await fs.stat(file);
            const metadata = await this.readKiroMetadata(file);
            const preview = await this.readKiroMessagePreview(file);
            const pathId = basename(dirname(file));
            const metadataId = this.firstString(metadata, ['id', 'sessionId', 'session_id', 'conversationId', 'conversation_id']);
            const id = metadataId || pathId;
            if (!this.isSafeConversationId(id)) {
                return undefined;
            }
            const cwd = this.firstString(metadata, ['cwd', 'workspace', 'workspacePath', 'workspace_path', 'projectPath', 'project_path', 'key']);
            const updatedAt = this.toIsoDate(
                this.firstString(metadata, ['updatedAt', 'updated_at', 'lastUpdatedAt', 'last_updated_at']),
                stat.mtime
            );
            const summary: SyncedConversationSummary = {
                id,
                provider: 'kiro',
                title: this.cleanTitle(this.firstString(metadata, ['title', 'name', 'summary']))
                    || this.titleFromText(preview.firstUserMessage, 'Kiro conversation'),
                workspace: this.workspaceName(cwd, this.workspaceName(dirname(dirname(file)), 'Kiro')),
                cwd,
                updatedAt,
                active: Date.now() - stat.mtimeMs < ACTIVE_FILE_WINDOW_MS,
                messageCount: undefined
            };
            this.locators.set(this.locatorKey('kiro', id), {
                provider: 'kiro',
                kind: 'jsonl',
                path: file,
                summary
            });
            return summary;
        });
        return conversations.filter((summary): summary is SyncedConversationSummary => Boolean(summary));
    }

    protected async listKiroSqliteConversations(databasePath: string): Promise<SyncedConversationSummary[]> {
        const sqlite = this.loadSqlite();
        if (!sqlite) {
            throw new Error('Kiro uses SQLite here, but this Node runtime does not provide node:sqlite.');
        }
        const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
        const conversations: SyncedConversationSummary[] = [];
        try {
            database.exec('PRAGMA query_only = ON');
            const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'conversation%'").all();
            for (const tableRow of tableRows) {
                const table = this.asRecord(tableRow)?.name;
                if (typeof table !== 'string' || !/^conversations?[a-z0-9_]*$/i.test(table)) {
                    continue;
                }
                const columns = database.prepare(`PRAGMA table_info("${table}")`).all()
                    .map(row => this.asRecord(row)?.name)
                    .filter((name): name is string => typeof name === 'string');
                const idColumn = ['conversation_id', 'session_id', 'id'].find(column => columns.includes(column));
                if (!idColumn) {
                    continue;
                }
                const rows = database.prepare(`SELECT * FROM "${table}"`).all();
                for (const rawRow of rows) {
                    const row = this.asRecord(rawRow);
                    const id = row && this.stringValue(row[idColumn]);
                    if (!row || !id || !this.isSafeConversationId(id)) {
                        continue;
                    }
                    const value = this.parseJsonValue(row.value);
                    const cwd = this.stringValue(row.key) || this.firstString(value, ['cwd', 'workspace', 'workspacePath', 'projectPath']);
                    const history = this.findHistory(value);
                    const firstMessage = history.map(item => this.normalizeKiroMessage(item, 0)).find(message => message?.role === 'user');
                    const updatedAt = this.toIsoDate(
                        this.stringValue(row.updated_at) || this.firstString(value, ['updatedAt', 'updated_at']),
                        (await fs.stat(databasePath)).mtime
                    );
                    const summary: SyncedConversationSummary = {
                        id,
                        provider: 'kiro',
                        title: this.cleanTitle(this.firstString(value, ['title', 'name', 'summary']))
                            || this.titleFromText(firstMessage?.body[0], 'Kiro conversation'),
                        workspace: this.workspaceName(cwd, 'Kiro'),
                        cwd,
                        updatedAt,
                        active: false,
                        messageCount: history.length || undefined
                    };
                    conversations.push(summary);
                    this.locators.set(this.locatorKey('kiro', id), {
                        provider: 'kiro',
                        kind: 'sqlite',
                        path: databasePath,
                        table,
                        rowId: id,
                        summary
                    });
                }
            }
        } finally {
            database.close();
        }
        return conversations;
    }

    protected async readCodexConversation(locator: ConversationLocator): Promise<SyncedConversationDetail> {
        const messages: SyncedConversationMessage[] = [];
        let truncatedMessages = 0;
        let pendingToolCalls = 0;
        let lineNumber = 0;
        const input = createReadStream(locator.path, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            lineNumber++;
            const record = this.parseJsonValue(line);
            if (!record || record.type !== 'response_item') {
                continue;
            }
            const payload = this.asRecord(record.payload);
            const type = this.stringValue(payload?.type);
            if (type && ['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(type)) {
                pendingToolCalls++;
                continue;
            }
            if (type !== 'message') {
                continue;
            }
            const role = this.stringValue(payload?.role);
            if (role !== 'user' && role !== 'assistant') {
                continue;
            }
            const body = this.extractTextParts(payload?.content);
            if (body.length === 0) {
                continue;
            }
            const message: SyncedConversationMessage = {
                id: this.stringValue(payload?.id) || `${locator.summary.id}-${lineNumber}`,
                role: role === 'assistant' ? 'agent' : 'user',
                body,
                toolCalls: role === 'assistant' && pendingToolCalls > 0 ? pendingToolCalls : undefined
            };
            if (role === 'assistant') {
                pendingToolCalls = 0;
            }
            truncatedMessages += this.pushBounded(messages, message);
        }
        return { ...locator.summary, messages, truncatedMessages };
    }

    protected async readClaudeConversation(locator: ConversationLocator): Promise<SyncedConversationDetail> {
        const messages: SyncedConversationMessage[] = [];
        let truncatedMessages = 0;
        let lineNumber = 0;
        const input = createReadStream(locator.path, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            lineNumber++;
            const message = this.normalizeClaudeMessage(this.parseJsonValue(line), lineNumber);
            if (message) {
                truncatedMessages += this.pushBounded(messages, message);
            }
        }
        return { ...locator.summary, messages, truncatedMessages };
    }

    protected async readKiroJsonlConversation(locator: ConversationLocator): Promise<SyncedConversationDetail> {
        const messages: SyncedConversationMessage[] = [];
        let truncatedMessages = 0;
        let lineNumber = 0;
        const input = createReadStream(locator.path, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            lineNumber++;
            const message = this.normalizeKiroMessage(this.parseJsonValue(line), lineNumber);
            if (message) {
                truncatedMessages += this.pushBounded(messages, message);
            }
        }
        return { ...locator.summary, messages, truncatedMessages };
    }

    protected async readKiroSqliteConversation(locator: ConversationLocator): Promise<SyncedConversationDetail | undefined> {
        const sqlite = this.loadSqlite();
        if (!sqlite || !locator.table || !locator.rowId) {
            return undefined;
        }
        const database = new sqlite.DatabaseSync(locator.path, { readOnly: true });
        try {
            database.exec('PRAGMA query_only = ON');
            const columns = database.prepare(`PRAGMA table_info("${locator.table}")`).all()
                .map(columnRow => this.asRecord(columnRow)?.name)
                .filter((name): name is string => typeof name === 'string');
            const idColumn = ['conversation_id', 'session_id', 'id'].find(column => columns.includes(column));
            if (!idColumn) {
                return undefined;
            }
            const rows = database.prepare(`SELECT * FROM "${locator.table}" WHERE "${idColumn}" = ?`).all(locator.rowId);
            const row = this.asRecord(rows[0]);
            if (!row) {
                return undefined;
            }
            const history = this.findHistory(this.parseJsonValue(row.value));
            const messages: SyncedConversationMessage[] = [];
            let truncatedMessages = 0;
            history.forEach((item, index) => {
                const message = this.normalizeKiroMessage(item, index + 1);
                if (message) {
                    truncatedMessages += this.pushBounded(messages, message);
                }
            });
            return { ...locator.summary, messages, truncatedMessages };
        } finally {
            database.close();
        }
    }

    protected normalizeKiroMessage(candidate: unknown, index: number): SyncedConversationMessage | undefined {
        const record = this.asRecord(candidate);
        if (!record) {
            return undefined;
        }
        const nested = this.asRecord(record.message) || this.asRecord(record.payload) || record;
        const roleValue = this.stringValue(nested.role) || this.stringValue(record.role) || this.stringValue(nested.type);
        const normalizedRole = roleValue?.toLowerCase();
        if (!normalizedRole || !['user', 'assistant', 'agent'].includes(normalizedRole)) {
            return undefined;
        }
        const body = this.extractTextParts(nested.content ?? nested.body ?? nested.text ?? nested.message);
        if (body.length === 0) {
            return undefined;
        }
        return {
            id: this.stringValue(nested.id) || this.stringValue(record.id) || `kiro-message-${index}`,
            role: normalizedRole === 'user' ? 'user' : 'agent',
            body,
            toolCalls: this.numberValue(nested.toolCalls ?? nested.tool_calls) || undefined
        };
    }

    protected normalizeClaudeMessage(candidate: unknown, index: number): SyncedConversationMessage | undefined {
        const record = this.asRecord(candidate);
        if (!record) {
            return undefined;
        }
        const nested = this.asRecord(record.message) || record;
        const role = (this.stringValue(nested.role) || this.stringValue(record.type))?.toLowerCase();
        if (role !== 'user' && role !== 'assistant') {
            return undefined;
        }
        const content = nested.content ?? record.content;
        const body = this.extractClaudeTextParts(content);
        if (body.length === 0) {
            return undefined;
        }
        const toolCalls = role === 'assistant' && Array.isArray(content)
            ? content.filter(block => this.stringValue(this.asRecord(block)?.type) === 'tool_use').length
            : 0;
        return {
            id: this.stringValue(record.uuid) || this.stringValue(nested.id) || `claude-message-${index}`,
            role: role === 'assistant' ? 'agent' : 'user',
            body,
            toolCalls: toolCalls || undefined
        };
    }

    protected extractClaudeTextParts(value: unknown): string[] {
        if (typeof value === 'string') {
            const text = value.trim();
            return text ? [text] : [];
        }
        if (Array.isArray(value)) {
            return value.flatMap(item => this.extractClaudeTextParts(item));
        }
        const record = this.asRecord(value);
        if (!record) {
            return [];
        }
        const blockType = this.stringValue(record.type);
        if (blockType && !['text', 'input_text', 'output_text'].includes(blockType)) {
            return [];
        }
        return this.extractTextParts(record.text ?? record.content);
    }

    protected async readClaudeMetadata(file: string): Promise<ClaudeConversationMetadata> {
        const metadata: ClaudeConversationMetadata = {};
        let lineNumber = 0;
        const input = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                lineNumber++;
                const record = this.parseJsonValue(line);
                if (!record) {
                    continue;
                }
                metadata.sessionId ||= this.firstString(record, ['sessionId', 'session_id']);
                metadata.cwd ||= this.firstString(record, ['cwd', 'projectPath', 'project_path']);
                if (!metadata.firstUserMessage) {
                    const message = this.normalizeClaudeMessage(record, lineNumber);
                    if (message?.role === 'user') {
                        metadata.firstUserMessage = message.body[0];
                    }
                }
                if ((metadata.sessionId && metadata.cwd && metadata.firstUserMessage) || lineNumber >= 200) {
                    break;
                }
            }
        } finally {
            lines.close();
            input.destroy();
        }
        return metadata;
    }

    protected async readCodexMetadata(file: string): Promise<Record<string, unknown>> {
        const firstLine = await this.readFirstLine(file);
        const record = this.parseJsonValue(firstLine);
        return this.asRecord(record?.payload) || {};
    }

    protected async readKiroMetadata(messagesFile: string): Promise<Record<string, unknown>> {
        for (const name of ['session.json', 'metadata.json', 'conversation.json']) {
            const candidate = join(dirname(messagesFile), name);
            if (!await this.pathExists(candidate)) {
                continue;
            }
            const stat = await fs.stat(candidate);
            if (stat.size > 2_000_000) {
                continue;
            }
            const parsed = this.parseJsonValue(await fs.readFile(candidate, 'utf8'));
            const record = this.asRecord(parsed);
            if (record) {
                return record;
            }
        }
        return {};
    }

    protected async readKiroMessagePreview(file: string): Promise<{ firstUserMessage?: string }> {
        let firstUserMessage: string | undefined;
        let lineNumber = 0;
        const input = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            lineNumber++;
            const message = this.normalizeKiroMessage(this.parseJsonValue(line), lineNumber);
            if (!message) {
                continue;
            }
            if (!firstUserMessage && message.role === 'user') {
                firstUserMessage = message.body[0];
                break;
            }
            if (lineNumber >= 50) {
                break;
            }
        }
        lines.close();
        input.destroy();
        return { firstUserMessage };
    }

    protected findHistory(value: Record<string, unknown> | undefined): unknown[] {
        if (!value) {
            return [];
        }
        for (const key of ['history', 'messages', 'conversation']) {
            if (Array.isArray(value[key])) {
                return value[key] as unknown[];
            }
        }
        const nested = this.asRecord(value.value) || this.asRecord(value.session);
        return nested ? this.findHistory(nested) : [];
    }

    protected extractTextParts(value: unknown): string[] {
        if (typeof value === 'string') {
            const text = value.trim();
            return text ? [text] : [];
        }
        if (Array.isArray(value)) {
            return value.flatMap(item => this.extractTextParts(item));
        }
        const record = this.asRecord(value);
        if (!record) {
            return [];
        }
        for (const key of ['text', 'input_text', 'output_text', 'content', 'body', 'message']) {
            if (record[key] !== undefined) {
                const parts = this.extractTextParts(record[key]);
                if (parts.length > 0) {
                    return parts;
                }
            }
        }
        return [];
    }

    protected async findKiroDatabaseCandidates(): Promise<string[]> {
        const candidates = [
            join(this.kiroRoot, 'data.sqlite3'),
            join(this.kiroRoot, 'kiro-cli', 'data.sqlite3'),
            process.env.APPDATA && join(process.env.APPDATA, 'kiro-cli', 'data.sqlite3'),
            process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'kiro-cli', 'data.sqlite3'),
            join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
            join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'kiro-cli', 'data.sqlite3')
        ].filter((candidate): candidate is string => typeof candidate === 'string');
        const unique = [...new Set(candidates.map(candidate => resolve(candidate)))];
        const found: string[] = [];
        for (const candidate of unique) {
            if (await this.pathExists(candidate)) {
                found.push(candidate);
            }
        }
        return found;
    }

    protected loadSqlite(): NodeSqliteModule | undefined {
        try {
            return require('node:sqlite') as NodeSqliteModule;
        } catch {
            return undefined;
        }
    }

    protected async findFiles(roots: string[], include: (file: string) => boolean): Promise<string[]> {
        const result: string[] = [];
        const visit = async (directory: string): Promise<void> => {
            let entries;
            try {
                entries = await fs.readdir(directory, { withFileTypes: true });
            } catch (error) {
                if (this.errorCode(error) === 'ENOENT') {
                    return;
                }
                throw error;
            }
            await Promise.all(entries.map(async entry => {
                const child = join(directory, entry.name);
                if (entry.isDirectory()) {
                    await visit(child);
                } else if (entry.isFile() && include(child)) {
                    result.push(child);
                }
            }));
        };
        for (const root of roots) {
            await visit(root);
        }
        return result;
    }

    protected async mapConcurrent<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
        const results = new Array<R>(items.length);
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await map(items[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
        return results;
    }

    protected async readJsonLines<T>(file: string, convert: (record: Record<string, unknown>) => T | undefined): Promise<T[]> {
        const result: T[] = [];
        if (!await this.pathExists(file)) {
            return result;
        }
        const input = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            const record = this.parseJsonValue(line);
            if (record) {
                const value = convert(record);
                if (value) {
                    result.push(value);
                }
            }
        }
        return result;
    }

    protected async readFirstLine(file: string): Promise<string> {
        const input = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                return line;
            }
            return '';
        } finally {
            lines.close();
            input.destroy();
        }
    }

    protected parseJsonValue(value: unknown): Record<string, unknown> | undefined {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        if (typeof value !== 'string' || !value.trim()) {
            return undefined;
        }
        try {
            return this.asRecord(JSON.parse(value));
        } catch {
            return undefined;
        }
    }

    protected asRecord(value: unknown): Record<string, unknown> | undefined {
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }

    protected firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = record && this.stringValue(record[key]);
            if (value) {
                return value;
            }
        }
        return undefined;
    }

    protected stringValue(value: unknown): string | undefined {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        if (typeof value === 'number') {
            return String(value);
        }
        return undefined;
    }

    protected numberValue(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    protected cleanTitle(value: unknown): string | undefined {
        const title = this.stringValue(value)?.replace(/\s+/g, ' ').trim();
        return title ? title.slice(0, 120) : undefined;
    }

    protected titleFromText(value: unknown, fallback: string): string {
        return this.cleanTitle(value) || fallback;
    }

    protected titleFromWorkspace(cwd: string | undefined, fallback: string): string {
        const workspace = this.workspaceName(cwd, '');
        return workspace ? `${workspace} conversation` : fallback;
    }

    protected async resolveCodexWorkspace(value: unknown): Promise<string> {
        return this.resolveExternalWorkspace(value, [
            this.codexRoot,
            resolve(join(homedir(), 'Documents', 'Codex'))
        ]);
    }

    protected async resolveClaudeWorkspace(value: unknown): Promise<string> {
        return this.resolveExternalWorkspace(value, [this.claudeRoot]);
    }

    protected async resolveExternalWorkspace(value: unknown, providerRoots: string[]): Promise<string> {
        const rawPath = this.stringValue(value)?.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
        if (!rawPath) {
            return 'Uncategorized';
        }
        const cwd = resolve(rawPath);
        const syntheticRoots = [
            ...providerRoots,
            resolve(tmpdir()),
            ...[process.env.TEMP, process.env.TMP]
                .filter((candidate): candidate is string => Boolean(candidate))
                .map(candidate => resolve(candidate))
        ];
        const genericRoots = [
            resolve(homedir()),
            resolve(join(homedir(), 'Desktop')),
            resolve(join(homedir(), 'Documents')),
            resolve(join(homedir(), 'Downloads'))
        ];
        if (genericRoots.includes(cwd) || syntheticRoots.some(root => this.isPathWithin(cwd, root))) {
            return 'Uncategorized';
        }
        try {
            if (!(await fs.stat(cwd)).isDirectory()) {
                return 'Uncategorized';
            }
        } catch {
            return 'Uncategorized';
        }
        const workspaceRoot = await this.findWorkspaceRoot(cwd);
        return this.workspaceName(workspaceRoot || cwd, 'Uncategorized');
    }

    protected async findWorkspaceRoot(start: string): Promise<string | undefined> {
        const repositoryRoot = await this.findAncestorWithMarker(start, ['.git', '.plastic', '.hg']);
        return repositoryRoot || this.findAncestorWithMarker(start, [
            'AGENTS.md',
            'package.json',
            'pyproject.toml',
            'Cargo.toml',
            'go.mod',
            'default.project.json',
            join('ProjectSettings', 'ProjectVersion.txt')
        ]);
    }

    protected async findAncestorWithMarker(start: string, markers: string[]): Promise<string | undefined> {
        let current = start;
        while (true) {
            for (const marker of markers) {
                if (await this.pathExists(join(current, marker))) {
                    return current;
                }
            }
            const parent = dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }

    protected isPathWithin(candidate: string, root: string): boolean {
        const pathFromRoot = relative(root, candidate);
        return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
    }

    protected workspaceName(value: unknown, fallback: string): string {
        const path = this.stringValue(value)?.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
        if (!path) {
            return fallback;
        }
        return basename(path) || path || fallback;
    }

    protected toIsoDate(value: unknown, fallback: Date): string {
        const candidate = value instanceof Date ? value : this.stringValue(value);
        const date = candidate ? new Date(candidate) : fallback;
        return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
    }

    protected pushBounded(messages: SyncedConversationMessage[], message: SyncedConversationMessage): number {
        messages.push(message);
        if (messages.length > MAX_RENDERED_MESSAGES) {
            messages.shift();
            return 1;
        }
        return 0;
    }

    protected locatorKey(provider: ConversationProvider, id: string): string {
        return `${provider}:${id}`;
    }

    protected isSafeConversationId(id: string): boolean {
        return id.length > 0 && id.length <= 180 && /^[a-z0-9._-]+$/i.test(id);
    }

    protected async pathExists(path: string): Promise<boolean> {
        try {
            await fs.access(path);
            return true;
        } catch {
            return false;
        }
    }

    protected errorCode(error: unknown): string | undefined {
        return this.asRecord(error)?.code as string | undefined;
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    protected unavailableResult(provider: ConversationProvider, message: string): {
        conversations: SyncedConversationSummary[];
        status: ConversationSourceStatus;
    } {
        return {
            conversations: [],
            status: { provider, available: false, conversationCount: 0, message }
        };
    }
}
