/********************************************************************************
 * Copyright (C) 2026 Fromanium.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { WorkflowKind } from './agent-focus-types';

export const WORKFLOWS: Array<{ kind: WorkflowKind; icon: string; description: string }> = [
    {
        kind: 'Spec',
        icon: 'codicon-notebook',
        description: 'Shape requirements, design, and an implementation task list.'
    },
    {
        kind: 'Plan',
        icon: 'codicon-list-tree',
        description: 'Investigate the workspace and propose a plan without editing files.'
    },
    {
        kind: 'Bug Fix',
        icon: 'codicon-debug-alt',
        description: 'Reproduce, diagnose, repair, and verify a concrete problem.'
    },
    {
        kind: 'Quick Spec',
        icon: 'codicon-zap',
        description: 'Move from a short idea to an execution-ready brief quickly.'
    }
];
