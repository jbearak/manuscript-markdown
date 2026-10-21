# CLI Tool

Standalone command-line tool for converting between Manuscript Markdown and DOCX.

## Installation

### Via setup.sh (recommended)

```sh
./setup.sh
```

This builds the CLI binary and installs it to `~/bin/manuscript-markdown`. Ensure `~/bin` is on your PATH.

### Via bun

```sh
bun run src/cli.ts <input> [options]
```
### Via npx (not currently supported)

`npx manuscript-markdown` is not currently available from npm because this repository/package is private and does not publish a CLI `bin` entry.

## Usage

Conversion direction is auto-detected from the input file extension.

### DOCX to Markdown

```sh
manuscript-markdown paper.docx
```

Produces `paper.md` and `paper.bib` (if citations are present).

Each warning goes to stderr, as for the tracked formatting changes import accepts, which Markdown has no syntax for (see [DOCX Converter](converter.md)).

### Markdown to DOCX

```sh
manuscript-markdown paper.md
```

Produces `paper.docx`. Automatically loads `paper.bib` if present.

## Options

| Flag | Applies to | Description | Default |
|------|-----------|-------------|---------|
| `--help` | both | Show help message | — |
| `--version` | both | Show version number | — |
| `--output <path>` | both | DOCX→MD: output **base path** (derives `.md` + `.bib`); MD→DOCX: literal output `.docx` path | derived from input |
| `--force` | both | Overwrite existing output files | `false` |
| `--citation-key-format <fmt>` | DOCX→MD | Citation key format: `authorYearTitle`, `authorYear`, `numeric` | `authorYearTitle` |
| `--bib <path>` | MD→DOCX | BibTeX file path | auto-detect |
| `--template <path>` | MD→DOCX | Template DOCX for styling | auto-reuse existing `.docx` |
| `--no-template` | MD→DOCX | Disable auto-reuse of existing DOCX styles | `false` |
| `--author <name>` | MD→DOCX | Author name | OS username |
| `--blockquote-style <style>` | MD→DOCX | Blockquote paragraph style: `Quote`, `IntenseQuote` | `Quote` |
| `--csl-cache-dir <path>` | MD→DOCX | CSL style cache directory | `~/.manuscript-markdown/csl-cache` |

With `--force`, DOCX→MD keeps the entries of the `.bib` file it overwrites, and the fields of an entry that the converted entry lacks, each written as BibTeX reads it, wherever it was in the entry: a macro, as `month = jan`, stays a macro, and a concatenation, as `"a" # b`, stays whole. The file's `@string` declarations stay too, as they were written, each where it was among the entries, so a field copied with a macro, as `note = extra`, reads as it did.

## Examples

```sh
# Convert DOCX with numeric citation keys
manuscript-markdown paper.docx --citation-key-format numeric

# Convert to DOCX with a template and specific author
manuscript-markdown paper.md --template styles.docx --author "Jane Doe"

# Force overwrite and specify output path
manuscript-markdown paper.docx --output /tmp/draft --force

# Use a specific BibTeX file
manuscript-markdown paper.md --bib references.bib
```
