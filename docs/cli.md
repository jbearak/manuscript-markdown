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

### Via npx

```sh
npx manuscript-markdown <input> [options]
```

## Usage

Conversion direction is auto-detected from the input file extension.

### DOCX to Markdown

```sh
manuscript-markdown paper.docx
```

Produces `paper.md` and `paper.bib` (if citations are present).

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
| `--output <path>` | both | Output file path | derived from input |
| `--force` | both | Overwrite existing output files | `false` |
| `--citation-key-format <fmt>` | DOCX→MD | Citation key format: `authorYearTitle`, `authorYear`, `numeric` | `authorYearTitle` |
| `--bib <path>` | MD→DOCX | BibTeX file path | auto-detect |
| `--template <path>` | MD→DOCX | Template DOCX for styling | none |
| `--author <name>` | MD→DOCX | Author name | OS username |
| `--mixed-citation-style <style>` | MD→DOCX | Mixed citation style: `separate`, `unified` | `separate` |
| `--csl-cache-dir <path>` | MD→DOCX | CSL style cache directory | `~/.manuscript-markdown/csl-cache` |

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