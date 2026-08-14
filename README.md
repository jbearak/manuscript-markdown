# Manuscript Markdown

A specification, converter, and VS Code extension for roundtrip research paper and documentation editing between [Markdown](https://daringfireball.net/projects/markdown/) and Microsoft Word. Preserves change tracking, comments, tables, [LaTeX](https://www.latex-project.org/) equations, and citations in both directions, including [Zotero](https://www.zotero.org/) bibliographic data.

## Background

- Wanted plain-text editing for research papers
- Found [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) and a [VS Code extension](https://github.com/jloow/vscode-criticmarkup) for it, which were used as starting points
- Needed a more comprehensive spec, and a converter, to collaborate with people who use Word and Zotero

## What It Is

1. A **specification** extending Markdown + CriticMarkup + Pandoc
2. A **converter** (DOCX ↔ Markdown)
3. A **VS Code extension**

**New to VS Code or Markdown?** The [Getting Started guide](docs/intro.md) walks you through everything from installation to your first document — no prior experience with code editors or plain-text tools required.

## Quick Start

### Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.manuscript-markdown) or [OpenVSX Registry](https://open-vsx.org/extension/jbearak/manuscript-markdown). Alternatively, download the `.vsix` package from the [releases page](https://github.com/jbearak/manuscript-markdown/releases), or [build from source](https://github.com/jbearak/manuscript-markdown/blob/main/docs/development.md).


### Usage

- **Annotations**: Click **Markdown Annotations** in the toolbar or right-click menu for comment, highlight, addition, deletion, and substitution marks
- **Formatting**: Click **Markdown Formatting** for bold, italic, lists, headings, links, code, and table reflow
- **DOCX Conversion**: Right-click a `.docx` file and select **Export to Markdown**, or use the **Export to Word** submenu to convert Markdown back to DOCX
- **Navigation**: Use `Alt+Shift+J` / `Alt+Shift+K` to jump between changes

The [sample file](sample.md) demonstrates citations, math, callouts, code blocks, comments, and track changes.

![left: a VS Code window with an editor and preview tab showing side-by-side; right: same document in Word](https://raw.githubusercontent.com/jbearak/manuscript-markdown/v1.0.1/sample.png)

### CLI

A standalone CLI tool is also available for terminal-based conversion. See [CLI Tool](docs/cli.md) for details.

```sh
manuscript-markdown paper.docx    # DOCX → Markdown
manuscript-markdown paper.md      # Markdown → DOCX
```

## Features

### Collaboration & Review

- **CriticMarkup annotations**: Track changes with comment attribution and timestamps
- **Colored highlights**: Highlight colors match Word's color palette
- **Word count**: Live word count in the status bar
- **AI-friendly**: Plain text in a git repository gives AI coding assistants full context — manuscript, bibliography, and revision history

### Academic Writing

- **Citations**: Full Zotero roundtrip with BibTeX export and field code reconstruction
- **Bibliographies**: Format citations according to any [CSL style](https://citationstyles.org/) (APA, Chicago, BMJ, IEEE, etc.); bundles 18 common styles for offline use and downloads others as needed
- **Equations**: LaTeX equation support (inline and display math), automatically converted to/from Word OMML

### Formatting & Authoring

- **Rich Text Support**: Markdown formatting toolbar for bold, italic, lists, headings, code, links, and tables
- **Preview**: Real-time syntax highlighting and Markdown preview rendering
- **Embedded Tables**: Embed tables from external .csv, .tsv, .xlsx, .dta, and .md files with a [single directive](docs/embedded-tables.md)

### Document Conversion

- **Import**: DOCX to Markdown conversion preserving formatting, comments, change tracking, and citations
- **Export**: Markdown to DOCX export with template support

## Known Limitations

- No marking comments as resolved (only delete)
- Multi-line patterns only render in the Markdown preview when starting at the beginning of a line (Word import/export and navigation are unaffected)

## Documentation

- [Getting Started](docs/intro.md)
- **Guides**:
  - [Research Papers](docs/guides/research-paper.md) — Citations, math, metadata
  - [Technical Documentation](docs/guides/documentation.md) — Code, tables, review
- [Specification Overview](docs/specification.md)
- [CriticMarkup Syntax](docs/criticmarkup.md)
- [Language Server](docs/language-server.md)
- [DOCX Converter](docs/converter.md)
- [Embedded Tables](docs/embedded-tables.md)
- [LaTeX Equations](docs/latex-equations.md)
- [Zotero Citation Roundtrip](docs/zotero-roundtrip.md)
- [Configuration](docs/configuration.md)
- [User Interface](docs/ui.md)
- [CLI Tool](docs/cli.md)
- [Development Guide](docs/development.md)

## License

This project is free and open-source software, licensed under [GPLv3](LICENSE.txt).
Contributions welcome!
