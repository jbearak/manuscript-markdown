# Development Guide

This guide covers building, testing, and contributing to Manuscript Markdown.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) - Package manager and runtime (handles all scripts and dependencies)

### Setup and Build

```bash
# Install dependencies
bun install

# Compile TypeScript
bun run compile

# Watch mode during development
bun run watch

# Run tests
bun test

# Package extension for distribution
bunx vsce package
```

## Development Notes

- **Language**: TypeScript (ES2022 target)
- **Package manager**: Bun (auto-loads `.env` files, no separate dotenv setup needed)
- **Testing**: Bun test runner with fast-check for property-based testing
- **Build tool**: VSCE (VS Code Extension compiler)

## Word Dirty-Flag Investigation

The Word dirty-flag workflow is opt-in and macOS-only.

```bash
# Discover the current simplest fixture that Word marks dirty
bun run word:dirty

# Verify the committed dirty-frontier baseline
bun run word:dirty --verify

# Run one built-in fixture only
bun run word:dirty --fixture single-paragraph

# Diagnose an arbitrary Markdown file and save XML diffs
bun run word:dirty test/fixtures/draft.md --bisect

# Run the Bun verification test when Word is available locally
bun run test:word-dirty
```

Artifacts are written to `scripts/word-roundtrip-output/dirty-flag/`. The harness stops at the first dirty fixture and defers more complex fixtures until simpler ones are clean.

## Project Structure

- `src/` - TypeScript source code
  - `extension.ts` - Extension entry point
  - `changes.ts` - Navigation logic for patterns
  - `formatting.ts` - Text transformation and formatting
  - `author.ts` - Author name and timestamp handling
  - `preview/` - Markdown preview rendering
- `syntaxes/` - TextMate grammars (syntax highlighting): `manuscript-markdown.json`, and `manuscript-markdown-comment-closer.json` for a comment's `<<}` on a later line than its opener, which Markdown's paragraph rule, starting again at each line, leaves out of the comment's span
- `media/` - CSS styles for preview
- `package.json` - Extension metadata, UI configuration, scripts
- `test/` - Test files
  - Property-based tests using fast-check
  - Unit tests for core functionality

## For Detailed Development Guidance

See [AGENTS.md](../AGENTS.md) for:
- Invariants to maintain
- Common pitfalls and learnings
- Code pointers for different subsystems
