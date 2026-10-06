# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

## Round-Trip Features

The converter supports DOCX → Markdown → DOCX round-tripping. The following features are preserved in both directions:

- **Title**: `title:` frontmatter ↔ Word `Title`-styled paragraphs (multiple entries supported)
- **Author**: `author:` frontmatter ↔ `dc:creator` in Document Properties (omitted if blank)
- **Text formatting**: Markdown syntax ↔ Word run formatting (bold, italic, underline, strikethrough, superscript, subscript, inline code)
- **Headings**: `#`–`######` Markdown headings ↔ Word heading styles (H1 through H6)
- **Lists**: Markdown list syntax ↔ Word numbering (bulleted and numbered with nesting)
- **Horizontal rules**: `---`, `***` or `___` ↔ an empty paragraph with a bottom border. Import writes every rule as `---`
- **Task lists**: `- [ ]` / `- [x]` parsed as semantic task items in Markdown and exported to deterministic DOCX list output with checkbox prefixes (`☐`/`☒`)
- **Comments**: non-overlapping comments use CriticMarkup `{==highlighted text==}{>>@author | comment<<}` format; overlapping comments use non-inline ID-based syntax (`{#1}highlighted text{/1}{#1>>@alice | comment<<}`) — see [Specification](specification.md#overlapping-comments)
- **Track changes**: CriticMarkup `{++...++}` and `{--...--}` ↔ Word revisions (`w:ins`/`w:del`). A paragraph break Word tracks, as a paragraph mark's revision, is a blank line inside the span. Where the block after it can't take the text before it, as a list item, a heading, a thematic break or a paragraph out of the quote, or there's none, as after the last paragraph of the document or a note, import writes it as a span of the blank line alone at the end of its paragraph, which export reads back as that paragraph's tracked mark
- **Citations**: Zotero field codes ↔ Pandoc `[@key]` syntax with BibTeX export. On import, `ZOTERO_BIBL` field codes are detected and omitted (bibliography is regenerated on export), and a field before the end of the document becomes a `<!-- references -->` marker. On export, bibliography is automatically generated as a `ZOTERO_BIBL` field for cited entries, at the marker (`<!-- references -->` or `<!-- bibliography -->`) or else appended at the end. A marker with no entries to list, as without a `.bib` file, still gets the field, empty and in a hidden paragraph, so it comes back on import, unless it ends the document, where the bibliography goes anyway (see [Specification](specification.md#bibliography-placement)). If no `csl` style is specified, a nonempty bibliography uses bundled APA formatting. Mixed Zotero/non-Zotero grouped citations always produce unified output — a single set of parentheses wrapping all entries (see [Zotero Round-Trip](zotero-roundtrip.md#mixed-citations)). Missing keys appear inline as `@citekey` with a post-bibliography note.
- **Zotero document preferences**: CSL style, locale, and note type round-tripped between YAML frontmatter (`csl`, `locale`, `zotero-notes`) and `docProps/custom.xml` (`ZOTERO_PREF_*` properties)
- **Math**: OMML equations ↔ LaTeX (`$inline$`, `$$display$$`, and bare `\begin{env}...\end{env}`)
- **Hyperlinks**: Markdown links ↔ Word hyperlinks (with proper escaping)
- **Autolink literals**: bare URLs (e.g., `https://example.com`) are linkified during Markdown parsing and exported as hyperlinks. A URL that is plain text in Word imports as `https\://example.com`, which stays plain text. A Word hyperlink whose text is its URL or email address imports bare where linkify reads it back as that link, and as `[https\://example.com](https://example.com)` where the text next to it would join it, as in `https://example.com/a**b**`, or where linkify would show it otherwise, as it decodes `%20`
- **Text that reads as Markdown**: import puts a backslash before each character of Word's text that Markdown would take for syntax, and only there, so the text exports as it was. That covers emphasis (`\_a\_`), code, math, links, notes, highlights, strikethrough, CriticMarkup, HTML comments, character references (`\&amp;`), a backslash before punctuation, and, at the start of a line, headings, lists, quotes, thematic breaks, task boxes and alert markers (`\# Note`, `1\. Item`, `\[ ] a`). Brackets around a citation key, as in `[see @key]`, stay a citation where export knows the key: one the document cites, one in its bibliography, or one whose missing citation data export noted at the document's end. Export writes a citation it can't write as a field as that text, as for a missing key or a deleted citation. Brackets around any other key are escaped, as `\[@key]`, so they stay text, with no note of a missing key, but not in a note or a deletion, where export notes no missing key, so brackets around any key stay a citation
- **Highlights**: colored highlights ↔ `==text=={color}` syntax
- **Blockquotes**: `> quoted text` ↔ Word GitHub Blockquote, Quote or Intense Quote paragraph style (with nesting). `blockquote-style` picks the style, and import sets it from the style of a Word document's quotes (see [YAML Frontmatter](#yaml-frontmatter))
- **Alert callout labels**: GitHub-style alert callouts show their type label by default in preview and DOCX output. Set `callout-labels: false` in YAML frontmatter to omit the visible label row while preserving the callout body, type, colors, border, and other styling. Explicit `true` and `false` values round-trip through the `MANUSCRIPT_CALLOUT_LABELS` custom property in `docProps/custom.xml`.
- **Tables**: DOCX→Markdown import uses a fallback cascade: pipe tables → grid tables → HTML tables. Pipe tables are preferred for simple single-paragraph cells within `pipeTableMaxLineWidth`, where the first row is the table's one header row; grid tables handle wider content within `gridTableMaxLineWidth`, with each line break in a cell as a line of it; HTML tables are the final fallback and the only format supporting `colspan`/`rowspan` and cells of more than one paragraph, which a grid table would write as lines that export reads as one paragraph with line breaks. When a stored format exists (from a previous round-trip via `MANUSCRIPT_TABLE_FORMATS` custom property), that format is used directly without width limits to preserve fidelity (`'pipe'` → pipe → HTML; `'grid'` → grid → HTML; `'html'` → HTML). A table stored as HTML whose cells now hold what an HTML cell can't, such as a comment, a tracked change or a citation, falls back as if it had no stored format, unless it has merged cells. Such a table, whose cells HTML can't hold, is a grid table of any width before it is HTML, even with a line width of 0, so its cells keep their content, though not a cell's own alignment, unless a cell holds more than one paragraph. Import writes an HTML table's cells as HTML: formatting as tags, whitespace HTML would collapse as character references, and each paragraph as a `<p>`. Alignment, from `:` in a pipe or grid table's separator or a cell's `align`, goes to Word as its paragraphs' alignment, and back as the column's, where its cells share one, or in an HTML table the cell's. Both `pipeTableMaxLineWidth` and `gridTableMaxLineWidth` are configurable via frontmatter, CLI, VS Code settings, and DOCX custom properties (default: 120; set to 0 to skip that format). Markdown→DOCX export accepts pipe tables, grid tables, and HTML tables (with `colspan` and `rowspan` support). Embed directives (`<!-- embed: path -->`) are expanded into full tables on export; the original directive is stored as a `MANUSCRIPT_EMBED_DIRECTIVES` custom property so that re-importing the DOCX recovers the embed reference. See [Embedded Tables](embedded-tables.md)
- **Code blocks**: fenced code blocks (`` ``` ``) ↔ Word "Code Block" paragraph style. Language annotations (e.g., `` ```stata ``) preserved via `MANUSCRIPT_CODE_BLOCK_LANGS` custom property. Inline code (`` `text` ``) uses the `CodeChar` character style (Consolas font, same as code blocks).
- **Footnotes/endnotes**: `[^label]` references and `[^label]: text` definitions ↔ Word footnotes/endnotes. Named labels preserved via `MANUSCRIPT_FOOTNOTE_IDS` custom property. See [Specification](specification.md#footnotes).
- **HTML comments**: `<!-- ... -->` comments (both inline and block-level) are preserved as invisible runs in the DOCX and restored on re-import. See [HTML Comments](#html-comments) below.
- **Images**: `![alt](path){width=W height=H}` and `<img>` syntax ↔ Word `<w:drawing>` inline images. Dimensions accept bare pixel values plus `px`, `in`, `cm`, `mm`, `pt`, and `pc`, and are preserved through EMU↔pixel conversion. Alt text is preserved via `<wp:docPr descr="...">`. Syntax format (Markdown vs HTML) is preserved via `MANUSCRIPT_IMAGE_FORMATS` custom property. Image binaries are extracted to/from `word/media/`.
- **Line breaks**: Word line breaks (`<w:br/>`, Shift+Enter) are imported as `\` + newline. On export, a trailing `\` at the end of a line produces `<w:br/>`. Bare newlines are soft breaks (spaces) unless `breaks: true` is set in frontmatter. See [Specification](specification.md#line-breaks).
- **Line spacing and indent**: `line-spacing`, `paragraph-indent`, and `bibliography-hanging-indent` frontmatter settings round-trip via `MANUSCRIPT_LINE_SPACING`, `MANUSCRIPT_PARAGRAPH_INDENT`, and `MANUSCRIPT_BIBLIOGRAPHY_HANGING_INDENT` custom properties in `docProps/custom.xml`. Per-paragraph `<!-- indent -->` / `<!-- no-indent -->` overrides round-trip via `MANUSCRIPT_INDENT_OVERRIDES` custom properties

## LaTeX Equations

The converter translates between LaTeX math notation in Markdown and Microsoft Word's OMML (Office Math Markup Language) equation format. Conversion is bidirectional: DOCX import translates OMML to LaTeX, and Markdown export translates LaTeX back to OMML. Bare `\begin{env}...\end{env}` blocks (without `$$` wrappers) are preprocessed into `$$\begin{env}...\end{env}$$` before parsing, so the existing math pipeline handles them transparently. See [LaTeX Equations](latex-equations.md) for the full syntax reference.

### DOCX to Markdown (OMML to LaTeX)

When importing a Word document, the converter reads `m:oMath` and `m:oMathPara` XML elements from the DOCX and translates each OMML construct into the corresponding LaTeX command. Inline equations become `$...$` and display (paragraph-level) equations become `$$...$$`.

The OMML-to-LaTeX translator (`src/omml.ts`) walks the parsed XML tree and dispatches each element type to a specialized translator function — fractions become `\frac{}{}`, superscripts become `^{}`, matrices become `\begin{matrix}...\end{matrix}`, and so on.

### Markdown to DOCX (LaTeX to OMML)

When exporting to Word, the converter tokenizes the LaTeX string, parses it into a sequence of atoms with proper operator precedence (script binding, grouping, n-ary operators), and emits the corresponding OMML XML.

The LaTeX-to-OMML translator (`src/latex-to-omml.ts`) uses a recursive-descent parser that handles:

- **Script binding**: `^` and `_` attach to the nearest preceding atom, not the whole expression
- **Multi-character splitting**: consecutive letters like `abc` are split into individual math runs (`a`, `b`, `c`) to match Word's italicized-variable convention
- **Delimiter parsing**: `\left...\right` pairs with proper handling of invisible delimiters (`.`)
- **Environment parsing**: `\begin{...}...\end{...}` blocks for matrices, alignment, and cases

### Round-Trip Behavior

The converter aims for **semantic fidelity** rather than syntactic identity. A round trip (DOCX → Markdown → DOCX) preserves the mathematical meaning and visual appearance of equations, but the LaTeX source may differ from what a human would write by hand. Specific behaviors:

- **Multi-letter variables**: OMML renders each letter as a separate italic run. On import, consecutive single-letter runs produce individual variables (e.g., `abc` stays as three separate italic letters `a`, `b`, `c`). Multi-letter runs with upright styling import as `\mathrm{...}`.
- **Fraction variants**: `\dfrac`, `\tfrac`, and `\cfrac` all produce the same OMML fraction element. On re-import, they all become `\frac`.
- **Binomial variants**: `\dbinom` and `\tbinom` produce the same OMML as `\binom`. On re-import, they become `\binom`.
- **Environment selection**: On OMML-to-LaTeX import, equation arrays with `&` markers become `aligned` environments; those without become `gathered`. The original environment name (`align*`, `multline`, etc.) is not preserved since OMML does not store it.
- **Unsupported elements**: OMML constructs with no LaTeX equivalent produce a visible `\text{[UNSUPPORTED: element] content}` placeholder.
- **Bare environments**: `\begin{env}...\end{env}` (without `$$` wrappers) round-trips as `$$\begin{env}...\end{env}$$`.

### Comment Handling

LaTeX `%` comments are preserved through the export/import round trip. During Markdown-to-DOCX export, the converter strips comment text from the visible OMML output so it does not appear in the Word equation. Each comment is embedded as a non-visible element within the OMML structure at the position where the comment occurred, storing both the comment text and the preceding whitespace. On DOCX-to-Markdown re-import, the converter detects these hidden elements and restores them as LaTeX `%` comments with their original whitespace, so vertically aligned comments remain aligned after a round trip.

Line-continuation `%` (a `%` at end-of-line used to suppress newline whitespace) is handled the same way: stripped from visible output, embedded as a hidden marker, and restored on re-import. Escaped `\%` is unaffected and continues to render as a literal `%` symbol.

### Architecture

The converter is implemented in two modules:

| File | Direction | Entry point |
|------|-----------|-------------|
| `src/latex-to-omml.ts` | LaTeX → OMML | `latexToOmml(latex: string): string` |
| `src/omml.ts` | OMML → LaTeX | `ommlToLatex(children: any[]): string` |

Both modules use their own mapping tables (Unicode ↔ LaTeX, accent characters, n-ary operators) that are kept in sync. The LaTeX-to-OMML direction uses a tokenizer and recursive-descent parser; the OMML-to-LaTeX direction walks the parsed XML tree using fast-xml-parser.

## HTML Comments

HTML comments (`<!-- ... -->`) are preserved through the DOCX round trip. Both inline comments (e.g., `text <!-- note --> more text`) and block-level comments (standalone `<!-- TODO -->` on their own line) are supported.

### Markdown to DOCX

During export, HTML comments are encoded as invisible runs in the Word document XML:

```xml
<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">​<!-- comment --></w:t></w:r>
```

The `<w:vanish/>` run property makes the text invisible in Word's UI, and a zero-width space (`U+200B`) prefix marks the run as a comment carrier. The comment text (including `<!-- -->` delimiters) is preserved exactly, with special characters XML-escaped.

### DOCX to Markdown

During import, the converter detects vanish-styled runs whose text starts with `U+200B` followed by `<!--`. These are emitted as `html_comment` content items and rendered back as raw `<!-- ... -->` syntax. If a Word user annotated the region containing the hidden comment, the associated Word comment is preserved using CriticMarkup or ID-based syntax.

### Inert Zones

HTML comment delimiters inside code spans, fenced code blocks, LaTeX math, or CriticMarkup regions are treated as literal text by the Markdown parser and are not affected by this mechanism.

## Images

The converter handles image extraction from DOCX and embedding into DOCX, with full roundtrip support for dimensions, alt text, and syntax format.

### DOCX to Markdown

When importing a Word document, the converter:

1. Parses image relationships from `word/_rels/document.xml.rels`
2. Extracts image binaries from `word/media/` and saves them to an Image Folder (named after the Markdown file's basename)
3. Resolves filenames from `<wp:docPr name="...">` when available, falling back to the media filename
4. Converts dimensions from EMUs to pixels (1 pixel = 9,525 EMUs)
5. Reads alt text from `<wp:docPr descr="...">`
6. Emits Markdown image references using the syntax recorded in `MANUSCRIPT_IMAGE_FORMATS` metadata (defaulting to attribute syntax for DOCX files authored in Word)

Anchored/floating images (`<wp:anchor>`) are treated as inline — wrapping and positioning metadata is discarded.

### Markdown to DOCX

When exporting to Word, the converter:

1. Reads image files from disk, resolved relative to the Markdown file's directory
2. Stores image binaries in `word/media/` with deduplication (multiple references to the same file share one media entry)
3. Generates `<w:drawing><wp:inline>` OOXML with `<wp:extent>` (dimensions in EMUs), `<wp:docPr>` (alt text and filename), and `<a:blip>` (image reference)
4. Falls back to intrinsic image dimensions when explicit dimensions are not specified
5. Records each image's original syntax format in the `MANUSCRIPT_IMAGE_FORMATS` custom property for roundtrip fidelity

An image it can't embed (a URL or data URI, an unsupported format, or a file it can't read) gets a warning, and its Markdown or `<img>` tag goes in the document as hidden text. Word doesn't show it, and import writes it back as it was. An image in a deletion exports as a deleted image, or as deleted hidden text.

### Round-Trip Behavior

- **Dimensions**: Pixel values are converted to EMUs on export and back to pixels on import. Sub-pixel precision is lost due to integer rounding.
- **Alt text**: Preserved exactly through `<wp:docPr descr="...">`.
- **Syntax format**: The original Markdown syntax (attribute syntax or HTML `<img>`) is restored on re-import via the `MANUSCRIPT_IMAGE_FORMATS` metadata.
- **Deduplication**: Multiple references to the same image file produce a single `word/media/` entry in the DOCX.

## Citation Key Formats

Configurable via `manuscriptMarkdown.citationKeyFormat`:

| Format | Example | Description |
|--------|---------|-------------|
| `authorYearTitle` (default) | `smith2020effects` | Author surname + year + first title word |
| `authorYear` | `smith2020` | Author surname + year |
| `numeric` | `1`, `2`, `3` | Sequential numbers |

## Usage

1. Right-click a `.docx` file in VS Code Explorer
2. Select **Export to Markdown**
3. Output: `filename.md` and `filename.bib` (if citations present)

Or use the command palette and select a file via dialog.

If output files already exist, you'll be prompted to replace, choose a new name, or cancel.

## Known Limitations

- **Complex nested tables**: nested `<table>` elements inside cells are not supported
- **Task-list round-trip normalization**: task list items are exported with deterministic checkbox prefixes in DOCX output. Import reads a `☐` or `☒` at the start of a list item, or of a paragraph indented the way export indents a bulleted task item, back as a task item. Exact original marker spelling (`[x]` vs `[X]`) is not preserved
- **Disallowed raw HTML handling**: disallowed tags from the GitHub Flavored Markdown extension set (`title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `script`, `plaintext`) are treated as literal text rather than executable/rendered HTML in parsing/preview paths

### Comment Boundary Expansion in Code Runs

CriticMarkup syntax cannot appear inside code regions (inline code spans or fenced code blocks) — code content is always literal text. When a DOCX document contains a comment anchored to text inside a code-styled run, the converter expands the comment boundaries so that the CriticMarkup annotation falls outside the code span. This is an intentional lossy transformation: the comment's precise anchoring within the code text is lost, but the comment itself is preserved.

Three cases are handled:

**Comment fully inside a code run**

The comment boundaries are expanded to surround the entire code span.

DOCX: code run `calculateTotal` with comment "rename this" anchored to `Total`

```markdown
{==`calculateTotal`==}{>>rename this<<}
```

**Comment ending inside a code run**

The comment end marker is moved to after the closing backtick.

DOCX: comment starts before the code run and ends inside it

```markdown
{==some text `calculateTotal`==}{>>review this section<<}
```

**Comment starting inside a code run**

The comment start marker is moved to before the opening backtick.

DOCX: comment starts inside the code run and ends after it

```markdown
{==`calculateTotal` and related logic==}{>>needs refactoring<<}
```

## Export to Word

The converter also supports exporting Markdown back to DOCX, completing the round-trip workflow: DOCX → Markdown (edit) → DOCX (submit).

### Usage

1. Open a Markdown file in VS Code
2. Click the **Export to Word** submenu in the editor title bar
3. Choose **Export to Word** for default styling, or **Export to Word with Template** to use a template DOCX for fonts, sizes, and spacing

If a companion `.bib` file exists with the same base name, it is automatically loaded for citation resolution. You can also specify a custom bibliography path in the YAML frontmatter using the `bibliography` field (see [Specification](specification.md#bibtex-companion-file)).

### YAML Frontmatter

When the Markdown file includes YAML frontmatter with a `csl` field, the converter uses [citeproc-js](https://github.com/Juris-M/citeproc-js) to format citations and bibliography according to the specified CSL style. This frontmatter is generated automatically when converting from DOCX (if the source document has Zotero preferences), but you can also add or change it manually:

```yaml
---
csl: apa
locale: en-US
zotero-notes: in-text
bibliography: shared/references
---
```

| Field | Description |
|-------|-------------|
| `title` | Document title. Multiple `title:` entries create multi-paragraph titles. |
| `author` | Document author. Written as `dc:creator` in Document Properties on export. |
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`, `bmj`) or absolute path to a `.csl` file. Defaults to `apa`. Non-bundled styles are downloaded automatically by the converter on first use. |
| `locale` | Optional locale override (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `zotero-notes` | Optional Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy alias: `note-type`. Legacy numeric values (0, 1, 2) are still accepted. |
| `notes` | Controls footnote/endnote generation: `footnotes` (default) or `endnotes`. Auto-detected on DOCX import. |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`) for comment and revision dates. Kept through a DOCX round trip, with comment dates written in it; import doesn't add it. |
| `bibliography` | Path to a `.bib` file (`.bib` extension optional). Aliases: `bib`, `bibtex`. See [Specification](specification.md#bibtex-companion-file). |
| `line-spacing` | Line spacing for body text: `single`, `1.5`, `double`, or a numeric multiplier. See [Specification](specification.md#line-spacing-and-paragraph-indent). |
| `paragraph-indent` | First-line paragraph indentation in inches (e.g., `0.5`). Set to `none` to disable. See [Specification](specification.md#line-spacing-and-paragraph-indent). |
| `bibliography-hanging-indent` | When `true` (default), bibliography entries use a hanging indent. Set to `false` to disable. |

Some settings leave no trace in the Word document: `locale` and `zotero-notes` without Zotero citations, `notes` without notes, `timezone`, `blockquote-style`, `colors` and `breaks`. Export stores them in the `MANUSCRIPT_FRONTMATTER_SETTINGS_*` custom properties, and import restores each one unless the document itself says otherwise (Zotero's preferences, or the kind of notes it has). Without a stored `blockquote-style`, as in a document from Word, import writes the style most of the body's quote paragraphs are in, so that the fewest change style, and on a tie the one that comes first. Alerts don't count. Quotes in GitHub's style, the default, need no setting. Import reads `code-font` and `code-font-size` from the Code Block style, as it reads the other fonts from theirs. An explicit setting equal to the default, such as `code-font: Consolas`, isn't written back.

> **`zotero-notes` vs `notes`:** These fields are independent. `zotero-notes` controls how Zotero citations render (in-text, footnotes, or endnotes) and is stored in `ZOTERO_PREF_*` document properties for Zotero to read. `notes` controls whether the document's own footnote/endnote references are placed at the bottom of each page (footnotes) or collected at the end (endnotes). For example, a document can use `zotero-notes: in-text` for citations while using `notes: endnotes` for its own notes.

#### Bundled CSL styles

The following 18 styles are bundled and available without downloading:

`apa`, `bmj`, `chicago-author-date`, `chicago-notes-bibliography`, `chicago-shortened-notes-bibliography`, `modern-language-association`, `ieee`, `nature`, `cell`, `science`, `american-medical-association`, `american-chemical-society`, `american-political-science-association`, `american-sociological-association`, `vancouver`, `nlm`, `nlm-brackets`, `harvard-cite-them-right`

The Chicago note styles use the Chicago Manual of Style 18th-edition identifiers. Existing documents may continue to use `chicago-fullnote-bibliography` (mapped to `chicago-notes-bibliography`) or `chicago-note-bibliography` (mapped to `chicago-shortened-notes-bibliography`). These legacy identifiers remain accepted but are hidden from selectors and completions, and a DOCX roundtrip normalizes them to the corresponding Chicago 18 identifier.

If a style is not bundled, you will be prompted to download it from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Downloaded styles are cached in VS Code's global storage for reuse across workspaces.

### Template Support

When using **Export to Word with Template**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions
- `word/settings.xml` — document-level settings

The template controls appearance while the Markdown controls content.
