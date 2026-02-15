# Manuscript Markdown Specification

Manuscript Markdown extends standard Markdown with CriticMarkup annotations, Pandoc citation syntax, and custom extensions for manuscript editing.

## YAML Frontmatter

Manuscript Markdown files may begin with a YAML frontmatter block delimited by `---`. The `title` field stores the document title:

```yaml
---
title: My Document Title
---
```

Multi-paragraph titles use multiple `title` entries:

```yaml
---
title: First Paragraph of Title
title: Second Paragraph of Title
---
```

The frontmatter may also include citation-related fields (`csl`, `locale`, `note-type`). See [DOCX Converter](converter.md) for details.

## Standard Markdown

Manuscript Markdown supports all [CommonMark](https://commonmark.org/) and [GitHub Flavored Markdown](https://github.github.com/gfm/) syntax:

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), inline code (`` `code` ``)
- **Headings**: `# H1` through `###### H6`
- **Lists**: bulleted (`- item`), numbered (`1. item`), task lists (`- [ ] item`)
- **Links**: `[text](url)`
- **Code blocks**: fenced with triple backticks
- **Blockquotes**: `> quoted text`
- **Tables**: pipe-delimited with alignment support

## Pandoc Extensions

### Citations

Pandoc-style citations using BibTeX keys:

- Single citation: `[@smith2020]`
- With locator: `[@smith2020, p. 20]`
- Multiple citations: `[@smith2020; @jones2021]`
- Suppress author: `[-@smith2020]`

Citations reference entries in a companion `.bib` file.

## CriticMarkup

Five annotation operations for tracking changes. See [CriticMarkup Syntax](criticmarkup.md) for details.

- Addition: `{++text++}`
- Deletion: `{--text--}`
- Substitution: `{~~old~>new~~}`
- Comment: `{>>text<<}`
- Highlight: `{==text==}`

## Custom Extensions

Manuscript Markdown adds colored highlights and comment attribution. See [Custom Extensions](custom-extensions.md) for details.

- Colored highlights: `==text=={color}`
- Comment attribution: `{>>author (date): text<<}`
