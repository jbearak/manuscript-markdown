# Manuscript Markdown Specification

Manuscript Markdown extends standard Markdown with CriticMarkup annotations, Pandoc citation syntax, and custom extensions for manuscript editing.

## YAML Frontmatter

Manuscript Markdown files may begin with a YAML frontmatter block delimited by `---`. The `title` field stores the document title:

```yaml
---
title: My Document Title
author: Jane Smith
csl: apa
locale: en-US
note-type: in-text
timezone: -05:00
bibliography: shared/references
---
```

Multi-paragraph titles use multiple `title` entries:

```yaml
---
title: First Paragraph of Title
title: Second Paragraph of Title
---
```

The frontmatter may also include citation-related fields (`csl`, `locale`, `note-type`) and metadata (`author`, `timezone`). See [converter](converter.md) for details on how these fields are handled during conversion.

| Field | Description |
|-------|-------------|
| `title` | Document title. Multiple `title:` entries create multi-paragraph titles. |
| `author` | Document author. Written as `dc:creator` in Document Properties on DOCX export. |
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`) or absolute path to a `.csl` file. Controls citation and bibliography formatting. |
| `locale` | Locale override for citation formatting (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `note-type` | Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`). Auto-generated on DOCX import for idempotent date roundtripping. |
| `bibliography` | Path to a `.bib` file for citation resolution. Aliases: `bib`, `bibtex`. The `.bib` extension is optional. Relative paths resolve from the `.md` file directory, then workspace root. `/`-prefixed paths resolve from workspace root, then as absolute OS paths. Falls back to `{basename}.bib` if not found. |

## Standard Markdown

Manuscript Markdown supports all [CommonMark](https://commonmark.org/) and [GitHub Flavored Markdown](https://github.github.com/gfm/) syntax:

- **Formatting**: bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`), underline (`<u>text</u>`), superscript (`<sup>text</sup>`), subscript (`<sub>text</sub>`), inline code (`` `code` ``)
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

Citations reference entries in a companion `.bib` file (see [BibTeX Companion File](#bibtex-companion-file) below).

### BibTeX Companion File

By default, citations reference a companion `.bib` file with the same base name as the Markdown file (e.g., `paper.md` uses `paper.bib`). You can override this by specifying a `bibliography` field in the YAML frontmatter:

```yaml
---
bibliography: shared/references.bib
---
```

The `.bib` extension is optional (`bibliography: shared/references` also works). Relative paths resolve from the `.md` file directory first, then the workspace root. Paths starting with `/` resolve from the workspace root first, then as absolute OS paths.

Each entry contains standard BibTeX fields:

- `author`, `title`, `journal`/`booktitle`, `year`, `volume`, `number`, `pages`
- `doi`, `url`, `publisher`, `edition`, `abstract`

When exported from Zotero via DOCX import, entries also include identity fields for roundtrip reconstruction:

- `zotero-key` — the Zotero item key
- `zotero-uri` — the Zotero item URI

These fields allow the Markdown-to-DOCX exporter to reconstruct Zotero field codes in the output document. See [Zotero Citation Roundtrip](zotero-roundtrip.md) for details.

## LaTeX Equations

Manuscript Markdown supports LaTeX math notation, which is converted to and from Word's OMML equation format during roundtrip conversion.

- **Inline math**: `$...$` — renders within the text flow
- **Display math**: `$$...$$` — renders as a centered block equation

Supported LaTeX elements include:

- Fractions (`\frac{a}{b}`), roots (`\sqrt{x}`, `\sqrt[n]{x}`)
- Greek letters (`\alpha`, `\beta`, `\Gamma`, etc.)
- Operators and relations (`\sum`, `\int`, `\leq`, `\geq`, `\neq`, etc.)
- Matrices (`\begin{matrix}...\end{matrix}`)
- Accents and decorations (`\hat{x}`, `\bar{x}`, `\vec{x}`, etc.)
- Subscripts and superscripts (`x_i`, `x^2`)

## CriticMarkup

Five annotation operations for tracking changes. See [CriticMarkup Syntax](criticmarkup.md) for details.

- Addition: `{++text++}`
- Deletion: `{--text--}`
- Substitution: `{~~old~>new~~}`
- Comment: `{>>text<<}`
- Highlight: `{==text==}`

[!NOTE]
We use CriticMarkup's `{==text==}` highlight syntax to denote text associated with a comment. To colorize text without commenting on it, see [colored highlights](#colored-highlights) below.

## Manuscript Extensions

Manuscript Markdown extends CriticMarkup with colored highlights, comment attribution, and overlapping comments.

### Colored Highlights

Standard Markdown highlight syntax with an optional color suffix:

```markdown
==highlighted text==          (default color)
==highlighted text=={red}     (red highlight)
==highlighted text=={blue}    (blue highlight)
```

#### Available Colors

14 colors matching the MS Word highlight palette:

| Color | Syntax |
|-------|--------|
| Yellow (default) | `==text==` or `==text=={yellow}` |
| Green | `==text=={green}` |
| Turquoise | `==text=={turquoise}` |
| Pink | `==text=={pink}` |
| Blue | `==text=={blue}` |
| Red | `==text=={red}` |
| Dark Blue | `==text=={dark-blue}` |
| Teal | `==text=={teal}` |
| Violet | `==text=={violet}` |
| Dark Red | `==text=={dark-red}` |
| Dark Yellow | `==text=={dark-yellow}` |
| Gray 50% | `==text=={gray-50}` |
| Gray 25% | `==text=={gray-25}` |
| Black | `==text=={black}` |

#### Distinction from CriticMarkup Highlights

- `{==text==}` is a **CriticMarkup highlight** (rendered with grey background)
- `==text==` is a **format highlight** (rendered with the configured default color)
- The `{color}` suffix is unambiguous because CriticMarkup uses `{` *before* `==`, not after

#### Configuration

The default highlight color can be configured via VS Code settings:

```json
{
  "manuscriptMarkdown.defaultHighlightColor": "yellow"
}
```

Unrecognized color values fall back to the configured default.

### Comment Attribution

Comments can include author name and timestamp:

```markdown
{>>alice (2024-01-15 14:30): This needs revision<<}
```

#### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `manuscriptMarkdown.includeAuthorNameInComments` | `true` | Include author name |
| `manuscriptMarkdown.authorName` | `""` | Override author name (empty = OS username) |
| `manuscriptMarkdown.includeTimestampInComments` | `true` | Include timestamp |

Timestamp format: `yyyy-mm-dd hh:mm` in local timezone.

### Overlapping Comments

Standard CriticMarkup comment syntax (`{==text==}{>>comment<<}`) does not support overlapping comment ranges. Manuscript Markdown adds ID-based comment syntax that allows comment ranges to overlap, nest, or share boundaries.

#### Syntax

##### Range Markers

- **Range start**: `{#id}` — marks where the comment's highlighted range begins
- **Range end**: `{/id}` — marks where the highlighted range ends

##### Comment Body with ID

`{#id>>comment text<<}`

The `#id` appears between `{` and `>>`, extending the existing comment syntax. Author and date parsing inside the body is unchanged.

#### Examples

##### Overlapping comments

```markdown
This is the first sentence of a {#1}paragraph. {#2}This is the second
sentence of a paragraph.{/2}{/1}

{#1>>alice (2024-01-15 14:30): This is comment 1.<<}
{#2>>bob (2024-01-15 14:31): This is comment 2.<<}
```

Comment 1 covers "paragraph. This is the second sentence of a paragraph." while comment 2 covers only "This is the second sentence of a paragraph." — their ranges overlap.

##### Nested comments

```markdown
{#outer}The entire {#inner}important{/inner} sentence.{/outer}

{#outer>>alice: General note<<}
{#inner>>bob: Key word<<}
```

##### Non-overlapping with IDs

When `alwaysUseCommentIds` is enabled, even non-overlapping comments use ID syntax:

```markdown
{#1}highlighted text{/1}{#1>>alice: note<<}
```

#### ID Format

IDs use `[a-zA-Z0-9_-]+` — alphanumeric characters, hyphens, and underscores. No spaces. The DOCX-to-Markdown converter generates numeric IDs; users may write descriptive IDs like `intro-note`.

#### Backward Compatibility

`{==text==}{>>comment<<}` continues to work unchanged. The new syntax is only required when comment ranges overlap. By default, the converter uses the traditional syntax for non-overlapping comments and switches to ID-based syntax only when overlapping is detected.

#### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `manuscriptMarkdown.alwaysUseCommentIds` | `false` | Always use ID-based comment syntax (`{#id}...{/id}{#id>>...<<}`) even for non-overlapping comments |

CLI flag: `--always-use-comment-ids`
