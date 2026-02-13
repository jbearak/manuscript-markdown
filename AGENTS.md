# AGENTS.md - LLM Guidance for mdmarkup

This file is intentionally short. It's a map to the docs and a short list of invariants that are easy to regress.

IMPORTANT: Treat this as a living document. When you fix a subtle bug or a recurring LLM mistake, update **"Learnings"** (and keep the pointers and invariants current) as part of the same change.

## What to read (in order)

User-facing:
- `README.md`
- `docs/` (guides and feature documentation)

Code (authoritative for behavior):
- Navigation: `src/changes.ts`
- Formatting: `src/formatting.ts`
- Preview: `src/preview/mdmarkup-plugin.ts`
- Syntax highlighting: `syntaxes/mdmarkup.json`

## Key invariants (do not regress)

- **Multi-line pattern support**
  - Patterns can span multiple lines including empty lines
  - Multi-line patterns must start at beginning of line for **preview rendering** only
  - Navigation commands (next/previous change) work for patterns at any position
  - See `src/changes.ts` getAllMatches() for pattern detection

- **Pattern filtering**
  - Overlapping/nested patterns are filtered to prevent duplicates
  - Use strict containment checks to identify overlapping matches

- **Configuration**
  - Author name handling respects `mdmarkup.authorName` setting and falls back to OS username
  - Timestamps are ISO 8601 format
  - See `src/author.ts` for implementation

- **Preview rendering**
  - markdown-it plugin handles both inline and block-level patterns
  - Multi-line patterns must start at line beginning for block-level detection
  - CSS classes are standardized in `media/mdmarkup.css`

## Quick commands

- Setup: `bun install`
- Compile: `bun run compile`
- Watch: `bun run watch`
- Test: `bun test`
- Package: `bunx vsce package`

## Learnings

- Multi-line pattern regex: Use `[\s\S]*?` for content (including newlines), not just `.+`
- TextMate grammar has limitations with complex multi-line patterns; focus on correctness in code, not perfect highlighting
- When filtering overlapping patterns, ensure the containment check covers both start and end positions
- table reflow: Preserve existing alignment/padding patterns; only reflow when explicitly requested
- Author name configuration: Always check settings first, then fall back to username via `os.userInfo()`
- Property tests: Use fast-check with constraints to avoid timeout on large generated strings; prefer shorter bounded generators
- Multi-line preview rendering: markdown-it requires patterns to start at block level (line beginning); use the block rule, not inline
- Table parsing: Handle edge cases like cells with pipes in code or quotes; use careful boundary detection
- VSIX packaging: Do not exclude `node_modules/**` in `.vscodeignore` when runtime deps are imported from `out/*.js`; doing so causes extension activation failure and "command not found" errors in installed builds (even if it works in extension development host)
- DOCX conversion outputs: Before writing `${base}.md` / `${base}.bib`, detect pre-existing targets and prompt with overwrite/rename/cancel to prevent silent data loss
