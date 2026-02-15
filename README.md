# Manuscript Markdown

A specification, converter, and VS Code extension for roundtrip manuscript editing between Markdown and MS Word, with Zotero citation support.

## Background

- Wanted plain-text editing for manuscripts
- Found [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) and a [VS Code extension](https://github.com/jloow/vscode-criticmarkup) for it, which were used as starting points
- Needed a more comprehensive spec, and a converter, to collaborate with people who use Word and Zotero

## What It Is

1. A **specification** extending Markdown + CriticMarkup + Pandoc
2. A **converter** (DOCX ↔ Markdown)
3. A **VS Code extension**

## Quick Start

### Installation

Download from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.manuscript-markdown) or install locally:

```bash
./setup.sh
```

### Usage

- **Annotations**: Click **Markdown Annotations** in the toolbar or right-click menu for comment, highlight, addition, deletion, and substitution marks
- **Formatting**: Click **Markdown Formatting** for bold, italic, lists, headings, links, code, and table reflow
- **DOCX Conversion**: Right-click a `.docx` file and select **Export to Markdown**, or use the **Export to Word** submenu to convert Markdown back to DOCX
- **Navigation**: Use `Alt+Shift+J` / `Alt+Shift+K` to jump between changes

## Features

- CriticMarkup annotations with comment attribution and timestamps
- Markdown formatting toolbar (bold, italic, lists, headings, code, links, tables)
- DOCX to Markdown conversion preserving formatting, comments, and citations
- Markdown to DOCX export with template support and Zotero field code reconstruction
- Zotero citation roundtrip with BibTeX export
- CSL citation style support — citations and bibliographies formatted according to any [CSL style](https://citationstyles.org/) (APA, Chicago, BMJ, IEEE, etc.) with 16 bundled styles and on-demand downloading of 10,000+ others
- Colored highlights with 14 color options
- Syntax highlighting and Markdown preview rendering
- Word count in status bar

## Known Limitations

- No table conversion from DOCX
- No marking comments as resolved (only delete)
- Multi-line patterns only render in preview when starting at beginning of line

## Documentation

- [Specification Overview](docs/specification.md)
- [CriticMarkup Syntax](docs/criticmarkup.md)
- [Custom Extensions](docs/custom-extensions.md)
- [DOCX Converter](docs/converter.md)
- [Zotero Citation Roundtrip](docs/zotero-roundtrip-spec.md)
- [Development Guide](docs/development.md)

## License

This project is free and open-source software, licensed under [GPLv3](LICENSE.txt).
Contributions welcome!
