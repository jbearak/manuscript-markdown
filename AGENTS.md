# AGENTS.md

## Overview

This is a VS Code extension that adds CriticMarkup support to Visual Studio Code. CriticMarkup is a syntax for marking up proposed changes in text: additions, deletions, substitutions, comments, and highlights. The extension provides syntax highlighting, snippets with keybindings, and navigation commands to cycle through changes.

## Development commands

- Setup dependencies:
```sh
bun install
```
- Compile TypeScript:
```sh
bun run compile
```
- Watch during development:
```sh
bun run watch
```
- Package a `.vsix` for local install or distribution:
```sh
bunx vsce package
```
- Install the built VSIX in VS Code:
```sh
code --install-extension vscode-criticmarkup-<version>.vsix
```

Notes:
- No lint or test scripts are configured in `package.json`.
- Bun auto-loads `.env` files; no separate dotenv setup is required.

## Code architecture

### Entry point: `src/extension.ts`

Responsibilities:
- Activation: fires on `onLanguage:markdown` and on CriticMarkup commands (`criticmarkup.nextChange`, `criticmarkup.prevChange`, `criticmarkup.test`).
- Syntax patterns: regexes for the five CriticMarkup types in `patterns`.
- Decorations: creates theme-aware `TextEditorDecorationType`s for each CriticMarkup kind.
- Event wiring: updates decorations on editor changes, document edits, and theme switches.

Key flows:
- Theme colors: `getThemeColors()` maps VS Code theme kinds (Light, Dark, HighContrast, HighContrastLight) to stable colors.
- Decoration lifecycle: `createDecorations()` disposes and recreates decoration types when themes change to avoid leaks.
- Pattern matching + apply: `updateDecorations()` scans the document text and assigns ranges per pattern, then calls `editor.setDecorations(...)` for each type.

Related resources:
- `snippets.json` — snippet bodies for CriticMarkup syntax
- `package.json` — extension metadata, activation events, commands, grammar contribution
- `syntaxes/criticmarkup.json` — TextMate injection grammar (path referenced in `package.json`)

## Tooling conventions (from AGENTS.md)

- Use Bun for all scripts and dependency management: `bun install`, `bun run <script>`.
- Use `bunx vsce package` to build the VSIX.
- Prefer Bun’s defaults (e.g., `.env` auto-loading) where applicable.
