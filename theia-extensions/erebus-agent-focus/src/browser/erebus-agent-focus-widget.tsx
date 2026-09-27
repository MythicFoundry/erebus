/********************************************************************************
 * Copyright (C) 2026 Fromanium.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ChatAgentService, ChatService } from '@theia/ai-chat';
import { CommonCommands, Message, ReactWidget } from '@theia/core/lib/browser';
import { CommandService } from '@theia/core/lib/common/command';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ConversationSyncService } from '../common/conversation-sync-protocol';
import { AgentFocusView } from './agent-focus-view';
import { ErebusAgentFocusCommands } from './erebus-agent-focus-commands';

@injectable()
export class ErebusAgentFocusWidget extends ReactWidget {
    static readonly ID = 'erebus.agentFocus';
    static readonly LABEL = 'Agent Focus';

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(ConversationSyncService)
    protected readonly conversationSyncService: ConversationSyncService;

    @inject(ChatService)
    protected readonly chatService: ChatService;

    @inject(ChatAgentService)
    protected readonly chatAgentService: ChatAgentService;

    @postConstruct()
    protected init(): void {
        this.id = ErebusAgentFocusWidget.ID;
        this.title.label = ErebusAgentFocusWidget.LABEL;
        this.title.caption = 'Direct parallel agent sessions';
        this.title.iconClass = 'codicon codicon-sparkle';
        this.title.closable = false;
        this.addClass('erebus-agent-focus-widget');
        this.node.tabIndex = 0;
        this.update();
    }

    protected onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        this.node.focus({ preventScroll: true });
    }

    protected render(): React.ReactNode {
        return <AgentFocusView
            conversationSyncService={this.conversationSyncService}
            chatService={this.chatService}
            chatAgentService={this.chatAgentService}
            onExitFocusMode={() => {
                this.commandService.executeCommand(ErebusAgentFocusCommands.LEAVE.id).catch(error => console.error(error));
            }}
            onOpenFullSettings={() => {
                this.commandService.executeCommand(ErebusAgentFocusCommands.LEAVE.id)
                    .then(() => this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id))
                    .catch(error => console.error(error));
            }}
            onCheckForUpdates={() => this.commandService.executeCommand('electron-theia:check-for-updates')}
        />;
    }
}
