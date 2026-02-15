# Implementation Plan: Standalone CLI Tools

## Overview

Build a single `manuscript-markdown` CLI binary that wraps the existing converter library. The CLI is a thin layer: argument parsing, file I/O, conflict detection, and dispatch to `convertDocx`/`convertMdToDocx`. Compiled via `bun build --compile` and installed by `setup.sh`.

## Tasks

- [x] 1. Create CLI argument parser and dispatch skeleton
  - [x] 1.1 Create `src/cli.ts` with `parseArgs(argv: string[]): CliOptions` pure function and main dispatch logic
    - Parse positional input path and all flags from the design (--help, --version, --output, --force, --citation-key-format, --bib, --template, --author, --mixed-citation-style, --csl-cache-dir)
    - Detect conversion direction from input file extension (.docx → DOCX-to-MD, .md → MD-to-DOCX)
    - Handle --help (print usage) and --version (print version from package.json) early exits
    - Exit with error for unknown flags, missing input, or unsupported extensions
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 1.2 Write property test: extension-based dispatch correctness
    - **Property 1: Extension-based dispatch correctness**
    - **Validates: Requirements 5.1, 5.2**

  - [x]* 1.3 Write property test: argument parser preserves all flag values
    - **Property 2: Argument parser preserves all flag values**
    - **Validates: Requirements 1.2, 1.3, 2.3, 2.4, 2.5, 2.8, 2.9, 4.3, 4.4**

- [x] 2. Implement DOCX→MD conversion path
  - [x] 2.1 Implement `runDocxToMd(inputPath, opts)` in `src/cli.ts`
    - Read input DOCX as Uint8Array
    - Derive output base path (or use --output)
    - Check output conflicts for .md and .bib files; exit with error if conflicts and no --force; report both files when both conflict
    - Call `convertDocx(data, opts.citationKeyFormat)` from `converter.ts`
    - Write .md file; write .bib only if bibtex content is non-empty
    - Print output file paths to stdout
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3_

  - [x]* 2.2 Write property test: output path derivation with --output override
    - **Property 3: Output path derivation with --output override**
    - **Validates: Requirements 1.4, 2.7**

  - [x]* 2.3 Write property test: dual conflict reporting for DOCX→MD
    - **Property 5: Dual conflict reporting for DOCX→MD**
    - **Validates: Requirements 3.3**

- [x] 3. Implement MD→DOCX conversion path
  - [x] 3.1 Implement `runMdToDocx(inputPath, opts)` in `src/cli.ts`
    - Read input .md as UTF-8 string
    - Auto-detect companion .bib file (same basename) unless --bib overrides
    - Read --template DOCX as Uint8Array if specified
    - Derive output path (or use --output)
    - Check output conflict; exit with error if conflict and no --force
    - Resolve author name: --author flag, then os.userInfo().username fallback
    - Build MdToDocxOptions with bibtex, authorName, templateDocx, cslCacheDir, sourceDir, onStyleNotFound (auto-download), mixedCitationStyle
    - Call `convertMdToDocx(markdown, options)` from `md-to-docx.ts`
    - Write .docx output
    - Print warnings to stderr, output path to stdout
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 4.1, 4.2, 4.3, 4.4, 4.5, 5.5, 5.6_

  - [x]* 3.2 Write property test: conflict detection respects --force
    - **Property 4: Conflict detection respects --force**
    - **Validates: Requirements 3.1, 3.2**

  - [x]* 3.3 Write property test: author name resolution
    - **Property 6: Author name resolution**
    - **Validates: Requirements 2.5, 2.6**

- [x] 4. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Update setup.sh to build and install CLI
  - [x] 5.1 Add CLI build step to `setup.sh`
    - After existing VSIX packaging, add `bun build src/cli.ts --compile --outfile dist/manuscript-markdown`
    - Create `~/bin` if it doesn't exist
    - Copy `dist/manuscript-markdown` to `~/bin/manuscript-markdown`
    - Ensure executable permissions (`chmod +x`)
    - Print installed path and PATH reminder
    - If CLI compilation fails, print error to stderr and continue with remaining steps
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7(setup).1, 7(setup).2, 7(setup).3, 7(setup).4, 7(setup).5, 7(setup).6_

- [x] 6. Add CLI documentation
  - [x] 6.1 Create `docs/cli.md` with full CLI documentation
    - Installation instructions (setup.sh, bun, npx)
    - Usage examples for both conversion directions
    - All flags with descriptions and defaults
    - _Requirements: 7.1, 7.3_

  - [x] 6.2 Add CLI section to `README.md`
    - Brief mention of CLI tool with link to `docs/cli.md`
    - _Requirements: 7.2_

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The CLI reuses existing converter functions — no conversion logic is duplicated
- `author.ts` imports `vscode` and must NOT be imported by the CLI; author resolution is handled inline
- Property tests use `fast-check` (already in devDependencies)
- `bun build --compile` bundles all dependencies into a single executable
