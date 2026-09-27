# Erebus

Erebus is an agent-first desktop IDE concept built on the actively maintained [Eclipse Theia IDE](https://github.com/eclipse-theia/theia-ide) Electron template. Its primary surface is a chat-first Agent Focus view for directing parallel sessions, handling blocking requests, and reviewing artifacts without making the code editor the center of every task.

The Agent Focus surface includes local Erebus fixtures plus read-only, live conversation discovery for Claude, Codex, and Kiro. Theia's real editor, terminal, source-control, extension, MCP, and AI-provider packages remain available underneath the focused surface.

## Why this foundation

- Theia IDE is an official desktop-product template rather than a one-off editor fork.
- The checkout tracks Theia `1.75.0-next.34`, Electron `42.8.1`, React 18, and the current Theia AI packages.
- It supports VS Code extensions through Open VSX while keeping the product shell fully customizable.
- The previously popular Void VS Code fork is now deprecated. It remains useful as a reference, but is not a sound base for a new maintained product.

## Agent Focus frontend

The Erebus surface follows a deliberate three-column hierarchy:

1. **Sessions** — grouped local, cloud, and CLI work with working, attention, paused, and complete states.
2. **Conversation** — the widest column, with tool-call disclosure, response metrics, change summaries, and a persistent composer.
3. **Context** — an optional brief, task progress, changed-file list, and inline diff review.

Implemented interactions include:

- creating structured or freeform sessions in a chosen workspace, then pinning, renaming, hiding, or removing local sessions;
- persisting local sessions, layout state, composer preferences, tags, categories, and the selected conversation across reloads;
- running Coder, Explore, or Code Reviewer through Theia's real chat service, with streaming responses, cancellation, reasoning controls, context attachments, and Coder autopilot;
- surfacing live tool approvals and structured agent questions as explicit attention cards without changing the active session;
- running individual or remaining workflow tasks through the agent and completing them only after a successful response;
- reviewing the live Theia change set, opening full diffs, applying or reverting files, and drafting file-specific feedback;
- navigating session and settings history with toolbar controls or `Ctrl/Cmd+[` and `Ctrl/Cmd+]`;
- resizing or collapsing the project rail, toggling the context panel, and using a focused settings surface for layout, source status, updates, and the full IDE settings editor;
- returning to the full Theia IDE and reopening Agent Focus with `Ctrl/Cmd+Alt+A`;
- moving and resizing the frameless Electron window, plus dedicated minimize, maximize/restore, full-screen, and close controls;
- discovering Claude, Codex, and Kiro conversations from their local stores, grouping them by provider and workspace, and loading message history on demand.

The main source is under [`theia-extensions/erebus-agent-focus`](theia-extensions/erebus-agent-focus). The color tokens live at the top of [`agent-focus.css`](theia-extensions/erebus-agent-focus/src/browser/style/agent-focus.css).

## Color system

| Role | Token | Value |
| --- | --- | --- |
| Session rail | `--erebus-rail` | `#0d0c10` |
| Agent canvas | `--erebus-canvas` | `#1f1a24` |
| Context panel | `--erebus-panel` | `#221d28` |
| Raised controls | `--erebus-raised` | `#2d2733` |
| Primary text | `--erebus-text` | `#f4f0f7` |
| Secondary text | `--erebus-text-secondary` | `#c3bbc9` |
| Agent accent | `--erebus-accent` | `#9362ff` |
| Working state | `--erebus-positive` | `#67d4b1` |
| Attention state | `--erebus-warning` | `#ffb454` |

The palette is inspired by Kiro's warm near-black and violet Agent Focus presentation, but the Erebus mark, component styling, copy, data, and implementation are original.

## Prerequisites

- Node.js `24.18.0` (recorded in `.node-version`; Node 22.22.2+ is also compatible with the toolchain)
- Yarn Classic 1.x
- On Windows, Visual Studio 2026 with the Desktop development with C++ workload

The repository pins `node-gyp` 13 because it includes Visual Studio 2026 detection. Earlier versions fail even when the C++ workload is installed. A local compatibility package uses Node's system-certificate API in place of the optional native `@vscode/windows-ca-certs` build, so the separate Spectre-mitigated C++ libraries are not required.

## Develop

```powershell
yarn install
yarn build:extensions
yarn electron build
yarn download:plugins
yarn electron start
```

`yarn download:plugins` installs the template's supported VS Code-compatible language and debugging extensions. Re-run it when the upstream plugin manifest changes.

For a faster browser-only visual pass:

```powershell
yarn browser build
yarn browser start
```

The Electron app opens directly into Agent Focus. Select **IDE** in the top-right to reveal the underlying workbench. Run **Erebus: Open Agent Focus** from the command palette, or press `Ctrl/Cmd+Alt+A`, to return.

## Local data and conversation sync

Erebus owns `~/.erebus`. Theia preferences, user storage, workspace metadata, chat sessions, plugin state, and backend settings resolve through that directory. Electron/Chromium state is kept under `~/.erebus/electron`, and AppImage built-in plugins are copied under `~/.erebus/builtInPlugins`. An explicit `THEIA_CONFIG_DIR` still overrides the default.

The Agent Focus conversation provider reads external stores without modifying them:

- **Claude:** `~/.claude/projects/<encoded-workspace>/*.jsonl` (or `CLAUDE_CONFIG_DIR`).
- **Codex:** `~/.codex/session_index.jsonl`, `~/.codex/sessions`, and `~/.codex/archived_sessions` (or `CODEX_HOME`).
- **Kiro:** `~/.kiro/sessions/**/messages.jsonl` plus current Kiro CLI SQLite stores (or `KIRO_HOME`).

Summaries refresh every 15 seconds and full history is streamed from disk only when a conversation is selected. The UI caps a rendered history at the latest 1,000 messages and reports how many older messages remain in the source. Claude and Codex sessions resolve to their repository or recognizable project root; missing paths, generic user folders, and generated scratch directories are grouped under `Uncategorized`. External conversations are currently read-only in Erebus; a two-way integration should resume Claude through its CLI, Codex through `codex app-server`, and Kiro through its ACP server rather than writing any product's private files.

## Architecture boundary

`ErebusAgentFocusContribution` owns Theia integration: it creates the widget, maximizes the main workbench area, hides the editor tab while focused, and restores the IDE shell when leaving. `AgentFocusView` owns frontend state and interactions. Fixtures remain isolated in `agent-focus-fixtures.ts`; `ConversationSyncService` is the backend filesystem boundary that maps Claude, Codex, and Kiro records into the same view models without exposing source paths to the browser.

## Upstream and license

Erebus began from the Eclipse Theia IDE template. The upstream copyright notices, MIT license, `NOTICE.md`, and third-party notices remain in the repository. New Erebus frontend code is provided under the same MIT license.
