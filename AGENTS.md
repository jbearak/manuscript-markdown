# AGENTS.md - LLM Guidance for Manuscript Markdown

Treat this as a living document. When you fix a subtle bug, add a comment in the relevant source file and update pointers/invariants here.

## What to read

User-facing: `README.md`, `docs/`
Code: `src/changes.ts` (navigation), `src/formatting.ts`, `src/preview/manuscript-markdown-plugin.ts` (preview), `syntaxes/manuscript-markdown.json` (syntax highlighting)

## Key invariants

- **Multi-line patterns** span multiple lines including blanks. Must start at line beginning for preview only; navigation works anywhere. See `src/changes.ts` getAllMatches().
- **Pattern filtering** — overlapping/nested patterns filtered via strict containment. See `src/changes.ts`.
- **Author config** — `manuscriptMarkdown.authorName` → OS username fallback. ISO 8601 timestamps. See `src/author.ts`.
- **Preview rendering** — markdown-it handles inline and block patterns. Multi-line requires line-beginning start for block-level. CSS in `media/manuscript-markdown.css`.

## Quick commands

    bun install          # setup
    bun run compile      # compile
    bun run watch        # watch
    bun test             # test
    bunx vsce package    # package

## Cross-cutting learnings

- Template literal corruption: never use `$$` in code touched by tool text-replacement operations — `$` is special in replacement strings and `$$` gets corrupted. Use string concatenation instead.
- Property tests: use fast-check with short bounded generators to avoid timeouts.
- TextMate grammar: complex multi-line patterns have limitations; focus on correctness in code, not perfect highlighting.

Per-module learnings live as comments in the corresponding source files.
