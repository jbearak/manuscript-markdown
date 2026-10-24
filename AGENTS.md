# AGENTS.md - LLM Guidance for Manuscript Markdown

Treat this as a living document. Per-module invariants belong as comments in the relevant source file. Only truly cross-cutting items (spanning multiple files or general principles) belong here.

## What to read

User-facing: `README.md`, `docs/`
Extension: `src/extension.ts` (entry point), `src/changes.ts` (navigation), `src/formatting.ts` (text transformations), `src/preview/manuscript-markdown-plugin.ts` (preview), `syntaxes/manuscript-markdown.json` (syntax highlighting)
Conversion: `src/converter.ts` (docx → md), `src/md-to-docx.ts` (md → docx)
LSP: `src/lsp/server.ts` (language server — diagnostics, completions)

## Cross-cutting learnings

- Template literal corruption: never use `$$` in code touched by tool text-replacement operations — `$` is special in replacement strings and `$$` gets corrupted. Use string concatenation instead.
- Regex parity invariant: keep navigation (`src/changes.ts`) plain-highlight lookaround logic in lockstep with `syntaxes/manuscript-markdown.json` and mirrored regex test copies.
- One reader for inline syntax: where CriticMarkup, comment ranges, format highlights, citations and cross-references start and end is decided only in `src/inline-syntax.ts`, which the preview plugin and `md-to-docx.ts` both call; each side only builds its own tokens. Don't add a recognizer to either side. `src/syntax-parity.test.ts` fuzzes both parsers against each other.
- Word dirty-flag invariants: see the 12 numbered invariants in the `md-to-docx.ts` file header.

Per-module invariants live as comments in the corresponding source files.

## Build system

- Bun is the sole package manager — there is no `package-lock.json`.
- Extension is bundled with esbuild (`esbuild.mjs`), not tsc. Two entry points: `src/extension.ts` → `out/extension.js`, `src/lsp/server.ts` → `out/server.js`. All runtime dependencies are inlined; `vsce package` runs with `--no-dependencies`.
- tsc is still used for type-checking (`bun run typecheck`) via `tsconfig.json`, but does not emit.
- Static assets (CSL styles/locales) are copied to `out/` by the `copy-csl` script.

## Quick commands

- `bun install` — install dependencies
- `bun run compile` — build the extension
- `bun test` — run all tests
- `bun run watch` — watch mode
- `bun run package` — package the extension
