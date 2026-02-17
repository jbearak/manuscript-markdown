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

## Project Structure

- `src/` - TypeScript source code
  - `extension.ts` - Extension entry point
  - `changes.ts` - Navigation logic for patterns
  - `formatting.ts` - Text transformation and formatting
  - `author.ts` - Author name and timestamp handling
  - `preview/` - Markdown preview rendering
- `syntaxes/` - TextMate grammar (syntax highlighting)
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
