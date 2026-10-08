# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

Import reads each XML part of a `.docx` in the encoding its byte-order mark or XML declaration names, as UTF-16, which some tools write, and in UTF-8 where neither names one.

## Round-Trip Features

The converter supports DOCX → Markdown → DOCX round-tripping. The following features are preserved in both directions:

- **Title**: `title:` frontmatter ↔ Word `Title`-styled paragraphs (multiple entries supported)
- **Author**: `author:` frontmatter ↔ `dc:creator` in Document Properties (omitted if blank)
- **Text formatting**: Markdown syntax ↔ Word run formatting (bold, italic, underline, strikethrough, superscript, subscript, inline code)
- **Headings**: `#`–`######` Markdown headings ↔ Word heading styles (H1 through H6). Import knows a heading style, and the Title, Quote and Intense Quote styles, by the name styles.xml gives it, which Word keeps in English, where its ID is another: Word in another language gives a built-in style an ID from the name it shows, as `berschrift1` for German's Überschrift 1. It finds the Normal, heading and Title styles whose fonts it reads by name too, as Normal is `Standard` in German, and by an ID that differs only in case, as `heading1`, as Word matches style IDs. Only paragraph styles count, as a paragraph takes no other: a character style whose ID is a built-in style's, as `Normal`, is neither that style nor keeps import from finding it by name, and the same holds for the table paragraph and code block styles whose fonts import reads. A custom style's font is read from the style of its ID whatever its type, as a custom style can be a character style. A paragraph's alignment and list numbering still come from its style under the document's own ID, as Word reads them.
- **Lists**: Markdown list syntax ↔ Word numbering (bulleted and numbered with nesting). Import reads a paragraph's list from its `w:numPr` or its paragraph style's, as Word's List Bullet and List Number styles give theirs. Where neither gives a `w:ilvl`, the paragraph is at the level linked to its style (a level's `w:pStyle`), or else at level 0. The paragraph's own `w:numId` and `w:ilvl` come before its style's, each by itself, and a `w:numId` of 0 takes the style's list away. A paragraph with no style has the default paragraph style's, and Word numbers no paragraph its style puts at a level linked to another style (a level's `w:pStyle`). A list that links to a list style (`w:numStyleLink`), as Word's multilevel lists do, has the levels of the style's definition, and counts apart from the style's other lists. An instance's level override (`w:lvlOverride`) can make its level bullets or numbers, or link it to another paragraph style, for that instance alone. A paragraph at a level Word shows no number for (`w:numFmt` none) is a paragraph of the list item above it, or a plain paragraph where no item is above it. It ends the items under that one even when it's empty, or every item where none is above it, and import writes nothing for it. The lists of the items it doesn't end go on, numbered as Word numbers them. Of empty paragraphs in a row, the one at the shallowest such level ends the most. Import drops the level's `w:lvlText`, as for any level. Word still counts the paragraph, so the levels under it start over after it. Import writes the number Word shows for each numbered item. Word counts the numbering instances (`w:num`) of one abstract numbering as one list. An instance's start override starts that list over at the instance's first paragraph only, and a level override with nothing in it starts its level at 0, as Word reads one. A level starts over after a higher one, or as its `w:lvlRestart` says, and a level a list starts under counts as used. Where Word starts a list over and Markdown would go on, import writes `<!-- -->` between them. Export gives each numbered list after the first an instance of its own, which starts over only its own level. The first list uses the instance numbers take (see the numbering part below), and the first sublist of a numbered item stays in its parent's instance, only where Word would number them as the Markdown does: from the template's `w:start` for the level (0 where it has none) or that instance's start override, and starting over after the parent as the level's `w:lvlRestart` has it, and where the template's styles number no paragraphs in the same count. A `w:start` or `w:lvlRestart` in an instance's level override, in a `w:lvl` there, counts on neither side, as Word ignores both ([MS-OI29500] 2.1.292 b and 2.1.282 b), though ECMA-376 has the `w:lvl` replace the level. A numbered list after bullets in the same count, where a template's bullets take an instance of the numbers' abstract numbering, gets its own start too, as the bullets moved the count on.
- **Horizontal rules**: `---`, `***` or `___` ↔ an empty paragraph with a bottom border. Import writes every rule as `---`
- **Task lists**: `- [ ]` / `- [x]` parsed as semantic task items in Markdown and exported to deterministic DOCX list output with checkbox prefixes (`☐`/`☒`)
- **Comments**: non-overlapping comments use CriticMarkup `{==highlighted text==}{>>@author | comment<<}` format; overlapping comments use non-inline ID-based syntax (`{#1}highlighted text{/1}{#1>>@alice | comment<<}`) — see [Specification](specification.md#overlapping-comments)
- **Track changes**: CriticMarkup `{++...++}` and `{--...--}` ↔ Word revisions (`w:ins`/`w:del`). A paragraph break Word tracks, as a paragraph mark's revision, is a blank line inside the span. Where the block after it can't take the text before it, as a list item, a heading, a thematic break, a table, a section's fence, as `<!-- landscape -->`, or a paragraph out of the quote or custom style block, or there's none, as after the last paragraph of the document or a note, import writes it as a span of the blank line alone at the end of its paragraph, which export reads back as that paragraph's tracked mark. An empty paragraph's tracked mark is a span of the blank line alone at the start of the next paragraph's text, or, before a block that can't take text, alone in a paragraph of its own, and the marks of empty paragraphs after it that the same revision tracks are more blank lines in that span. That span stays apart from a span with text before it, even in the same revision, as `{++A\n\n++}{++\n\n++}B`. Export ends a paragraph at each blank line of a span of blank lines alone, with the span's mark, an empty one where no text comes before it, but none at a blank line at the edge of a span with text in it. A heading's tracked mark is a blank line in a span after its text, with the text of a body paragraph after it on the line after, or, for a heading all in the change, the heading's marker in the span, as `{++# Heading++}`. A change of one author and time over text and images is one span on import, as `{++see ![a](a.png)++}`.
- **Citations**: Zotero field codes ↔ Pandoc `[@key]` syntax with BibTeX export. On import, `ZOTERO_BIBL` field codes are detected and omitted (bibliography is regenerated on export), and a field before the end of the document's body becomes a `<!-- references -->` marker. On export, bibliography is automatically generated as a `ZOTERO_BIBL` field for cited entries, at the marker (`<!-- references -->` or `<!-- bibliography -->`) or else appended at the end. A marker with no entries to list, as without a `.bib` file, still gets the field, empty and in a hidden paragraph, so it comes back on import, unless it ends the document, or only footnote or endnote definitions follow it, where the bibliography goes anyway (see [Specification](specification.md#bibliography-placement)). If no `csl` style is specified, a nonempty bibliography uses bundled APA formatting. Mixed Zotero/non-Zotero grouped citations always produce unified output — a single set of parentheses wrapping all entries (see [Zotero Round-Trip](zotero-roundtrip.md#mixed-citations)). Missing keys appear inline as `@citekey` with a post-bibliography note.
- **Zotero document preferences**: CSL style, locale, and note type round-tripped between YAML frontmatter (`csl`, `locale`, `zotero-notes`) and `docProps/custom.xml` (`ZOTERO_PREF_*` properties)
- **Math**: OMML equations ↔ LaTeX (`$inline$`, `$$display$$`, and bare `\begin{env}...\end{env}`)
- **Hyperlinks**: Markdown links ↔ Word hyperlinks (with proper escaping). Import reads a `HYPERLINK` field, which some documents hold for a link, as a link too, and a hyperlink's location in its target, a `w:anchor` or the field's `\l`, as its URL's fragment, as in `https://example.com/page#part-2`. It reads the field's address as Word writes it, quoted or not, with each `\\` a backslash, as in `C:\\Docs\\a.docx`. A link to a bookmark in the document alone imports as its text.
- **Autolink literals**: bare URLs (e.g., `https://example.com`) are linkified during Markdown parsing and exported as hyperlinks. A URL that is plain text in Word imports as `https\://example.com`, which stays plain text. A Word hyperlink whose text is its URL or email address imports bare where linkify reads it back as that link, and as `[https\://example.com](https://example.com)` where the text next to it would join it, as in `https://example.com/a**b**`, or next to whitespace written as a reference, as at a paragraph's edge, in `https://example.com/a&nbsp;`, or before a line break in a grid table's cell, or where linkify would show it otherwise, as it decodes `%20`
- **Link targets**: import escapes a backslash in a link's target before punctuation or at its end, and an `&` that starts a character reference, as Markdown would read them as an escape and a reference, so a UNC path's `\\server` comes back as `\\\server`. A target that starts with `<` goes in `<>`, with its own `<` and `>` escaped. Export's markdown-it encodes the characters a URL can't hold, as `%5C` for a backslash and `%20` for a space, as it does in any link
- **Text that reads as Markdown**: import puts a backslash before each character of Word's text that Markdown would take for syntax, and only there, so the text exports as it was. That covers emphasis (`\_a\_`), code, math, links, notes, highlights, strikethrough, CriticMarkup, HTML comments, character references (`\&amp;`), a backslash before punctuation, and, at the start of a line, headings, lists, quotes, thematic breaks, task boxes and alert markers (`\# Note`, `1\. Item`, `\[ ] a`). Brackets around a citation key, as in `[see @key]`, stay a citation where export knows the key: one the document cites, one in its bibliography, or one whose missing citation data export noted at the document's end. Export writes a citation it can't write as a field as that text, as for a missing key or a deleted citation. Brackets around any other key are escaped, as `\[@key]`, so they stay text, with no note of a missing key, but not in a note or a deletion, where export notes no missing key, so brackets around any key stay a citation
- **Highlights**: colored highlights ↔ `==text=={color}` syntax
- **Blockquotes**: `> quoted text` ↔ Word GitHub Blockquote, Quote or Intense Quote paragraph style (with nesting). `blockquote-style` picks the style, and import sets it from the style of a Word document's quotes (see [YAML Frontmatter](#yaml-frontmatter)). A quote in a list item is indented by the item's indent and a step for each level, and import reads a quote in the deepest open item its indent fits. A quote right after a sublist, in the item above it or in no list, has the indent of one with fewer levels in the sublist, so export records where it is (`MANUSCRIPT_BLOCKQUOTE_LIST_LEVELS`), with a hash of the start of its text, past an alert's label, from its first paragraph with any, its number of paragraphs, the number of quotes with both, and its place among them, and import finds the quote by those, not by its place among all quotes, and puts it there unless Word moved it, changed the start of its text or its number of paragraphs, or added or removed a quote with the same start and number of paragraphs, and reads it by its indent then
- **Alert callout labels**: GitHub-style alert callouts show their type label by default in preview and DOCX output. Set `callout-labels: false` in YAML frontmatter to omit the visible label row while preserving the callout body, type, colors, border, and other styling. Explicit `true` and `false` values round-trip through the `MANUSCRIPT_CALLOUT_LABELS` custom property in `docProps/custom.xml`. With the label hidden, Word has no paragraph for a marker that's a paragraph of its own, as in `> [!NOTE]`, then `>` and the alert's text, where it shows the label's paragraph. Export records those alerts in the `MANUSCRIPT_BLOCKQUOTE_ALERT_MARKER_ALONE_*` custom properties, and import writes the line of `>` back after the marker.
- **Tables**: DOCX→Markdown import uses a fallback cascade: pipe tables → grid tables → HTML tables. Pipe tables are preferred for simple single-paragraph cells within `pipeTableMaxLineWidth`, where the first row is the table's one header row; grid tables handle wider content within `gridTableMaxLineWidth`, with each line break in a cell as a line of it, and the spaces and tabs a line starts with, which would be its padding, as character references, `&#32;b`, before a comment too, as a cell's line starts no HTML block, though a line in a comment, which can't hold references, keeps its own spaces and tabs after the padding, and the backslash it may end in, which isn't a line break's; HTML tables are the final fallback and the only format supporting `colspan`/`rowspan` and cells of more than one paragraph, which a grid table would write as lines that export reads as one paragraph with line breaks. When a stored format exists (from a previous round-trip via `MANUSCRIPT_TABLE_FORMATS` custom property, found, as each table's other settings are, by the table export wrote that it is, from each one's first row and text in `MANUSCRIPT_TABLE_IDENTITIES`, so a table Word adds takes none), that format is used directly without width limits to preserve fidelity (`'pipe'` → pipe → HTML; `'grid'` → grid → HTML; `'html'` → HTML). A table stored as HTML whose cells now hold what an HTML cell can't, such as a comment, a tracked change or a citation, falls back as if it had no stored format, unless it has merged cells. Such a table, whose cells HTML can't hold, is a grid table of any width before it is HTML, even with a line width of 0, so its cells keep their content, though not a cell's own alignment, unless a cell holds more than one paragraph. Import writes an HTML table's cells as HTML: formatting as tags, whitespace HTML would collapse or drop as character references, as a space at the end of a paragraph, `<p>a&#32;</p>`, and each paragraph as a `<p>`. Alignment, from `:` in a pipe or grid table's separator or a cell's `align`, goes to Word as its paragraphs' alignment, and back as the column's, where its cells share one, or in an HTML table the cell's. Both `pipeTableMaxLineWidth` and `gridTableMaxLineWidth` are configurable via frontmatter, CLI, VS Code settings, and DOCX custom properties (default: 120; set to 0 to skip that format). Markdown→DOCX export accepts pipe tables, grid tables, and HTML tables (with `colspan` and `rowspan` support). It writes an empty paragraph between two tables with nothing else between them, as two tables after a blank line or in one HTML block, which Word would join into one table, in the body and in a note, and import reads an empty paragraph alone between two tables as nothing, so two tables of one HTML block stay in it. Embed directives (`<!-- embed: path -->`) are expanded into full tables on export; the original directive is stored as a `MANUSCRIPT_EMBED_DIRECTIVES` custom property so that re-importing the DOCX recovers the embed reference. See [Embedded Tables](embedded-tables.md)
- **Code blocks**: fenced code blocks (`` ``` ``) ↔ Word "Code Block" paragraph style. Language annotations (e.g., `` ```stata ``) preserved via `MANUSCRIPT_CODE_BLOCK_LANGS` custom property, and a note's by `MANUSCRIPT_NOTE_CODE_BLOCKS`, which gives the index of each note's first code block. Inline code (`` `text` ``) uses the `CodeChar` character style (Consolas font, same as code blocks).
- **Footnotes/endnotes**: `[^label]` references and `[^label]: text` definitions ↔ Word footnotes/endnotes. Named labels preserved via `MANUSCRIPT_FOOTNOTE_IDS` custom property. See [Specification](specification.md#footnotes).
- **HTML comments**: `<!-- ... -->` comments (both inline and block-level) are preserved as invisible runs in the DOCX and restored on re-import. See [HTML Comments](#html-comments) below.
- **HTML blocks**: an HTML block that isn't a comment alone, an image, line breaks or a table exports as its text, which Word shows. Import writes a paragraph of such text back as the block it was wherever export would show it as that text again: `<div>a</div>`, a block that starts with a comment and goes on, as `<!-- c --><pre>a</pre>`, and one whose first line is a formatting tag alone, as `<b>`, `bold text` and `</b>` on three lines. Word's text that export would read as more than text, as a comment alone, a whole `<table>` or an `<img>` tag, imports escaped, so it stays text. So does the text of a block where the Markdown before it on its line, or the whitespace at its edges, would keep it from reading as that text: after a task's box or an alert's marker with no label, on the marker's line or the next, where Markdown reads HTML inline, as in `- [ ] &lt;b&gt;`, and next to whitespace import writes as a reference, as in `&lt;b&gt;&nbsp;`, where the tag would be inline or the reference would be text in the block. So does a paragraph with more than the block's text in it, as a comment on it, which the block would show as text, as in `&lt;b&gt;{>>c<<}`. Escaped, the line ends of a block over lines, which Word holds in its text, are `&#10;`, as in `\<div>&#10;# heading&#10;</div>{>>c<<}`, so the lines after the first stay text, which Markdown would read as syntax at a line's start, and stay lines in Word. So does the text of a block a blank line ends, as `<b>`'s, where a line goes right after it, as a comment, directive, quote or equation in the paragraph does, at the top level or in the block's quote or list item, which the block would take in as its text, as in `&lt;b&gt;` with `<!-- c -->` on the next line, or `- &lt;b&gt;` with `  > q`. The next item of a list ends the block, so there it stays as it was. Before an equation in its paragraph, or comment bodies, on the lines after its text, any block's text stays escaped, as one that ends at its marker, as `<pre>a</pre>` or `<!-- c -->text`, would leave the equation a block of its own, which splits Word's paragraph. Where Word adds a line end in an HTML table's cell, as in a comment there, which would end the table's block, the HTML before the table on its line, as a comment, goes as a block of its own, and the table goes on lines of its own after it, as import writes a table with nothing before it in its block.
- **Images**: `![alt](path){width=W height=H}` and `<img>` syntax ↔ Word `<w:drawing>` inline images. Dimensions accept bare pixel values plus `px`, `in`, `cm`, `mm`, `pt`, and `pc`, and are preserved through EMU↔pixel conversion. Alt text is preserved via `<wp:docPr descr="...">`. Syntax format (Markdown vs HTML) is preserved via `MANUSCRIPT_IMAGE_FORMATS` custom property. Image binaries are extracted to/from `word/media/`.
- **Line breaks**: Word line breaks (`<w:br/>`, Shift+Enter) are imported as `\` + newline. A line feed or carriage return in Word's text (`<w:t>`), which Word never writes there but other tools do, is imported as the space Word shows for it. On export, a trailing `\` at the end of a line produces `<w:br/>`. Bare newlines are soft breaks (spaces) unless `breaks: true` is set in frontmatter. See [Specification](specification.md#line-breaks).
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

The `<w:vanish/>` run property makes the text invisible in Word's UI, and a zero-width space (`U+200B`) prefix marks the run as a comment carrier. The comment text (including `<!-- -->` delimiters) is preserved exactly, with special characters XML-escaped. That includes CriticMarkup in a comment over a line break, as `z <!-- {++x` then `y++} -->`, whose line breaks the comment keeps; the preview writes them too.

### DOCX to Markdown

During import, the converter detects vanish-styled runs whose text starts with `U+200B` followed by `<!--`. These are emitted as `html_comment` content items and rendered back as raw `<!-- ... -->` syntax. If a Word user annotated the region containing the hidden comment, the associated Word comment is preserved using CriticMarkup or ID-based syntax. Outside a table, a Word comment on the hidden comment takes ID-based syntax, `{#1}<!-- note -->{/1}` with its body on the next line, which keeps the HTML comment hidden and the Word comment's range, and a range Word started or ended inside the hidden run covers all of it. It does so only where the paragraph, as written, reads back as a paragraph with each of its HTML comments inline; otherwise the HTML block stays as it was, with the Word comment after it. The indent export put in the hidden run of a comment of its own goes, as the line is a paragraph, not an HTML block, and the indent would be text Word shows. After text Word shows on the same line of a paragraph, or of a table's cell, the spaces and tabs a hidden run holds outside its comments go too, as Word hid them and the paragraph would show them: Word's `mid `, a hidden ` <!-- b --> ` and ` rest` come back as `mid <!-- b --> rest`. Where the comments sit between text that dropping them all would join, one space stays, which keeps the words apart, as a space typed next to a hidden run can take its hidden formatting: Word's `mid`, ` <!-- b --> ` and `rest` come back as `mid <!-- b -->rest`. At a line's start, after a line break or an alert's label as at the paragraph's, they stay, as without them the comment would start an HTML block there.

Export reads math, a highlight, a code span and a citation's key across a comment, as it does across text: `$a<!-- x$ -->` is math. So the text before a comment is escaped as it would be before the comment's text: Word's `cost $` before a comment `<!-- x$ -->` comes back as `cost \$<!-- x$ -->`, and `==a` before `<!-- x== -->` as `\==a<!-- x== -->`. Emphasis doesn't pair across a comment. A link's text reads past one, as markdown-it reads a link's label past inline HTML, so a `]` in a comment closes no link: `[a<!-- ] -->](b)` is a link to `b`, and Word's `[a` before that comment and `](b)` comes back as `\[a<!-- ] -->](b)`.

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
- **Alt text**: Preserved exactly through `<wp:docPr descr="...">`. Export reads alt text as Markdown and keeps its text, so import escapes each character of Word's alt text that Markdown would read as syntax, such as a bracket, `*` or `$`, and every `<`, so a tag in it stays text, as `\<b>`, and writes a line break as `&#10;`. It escapes a `$` or `==` that the text after the image could close, which export would read as math or a highlight from inside the brackets past the `]`. Export's hidden text for a reference image it can't embed has its alt text escaped the same way, as though such text came after. Text before the image whose `$`, `==` or open tag the alt text could close is escaped too, as `a \$b ![c$](image.png)`, since export reads math, a highlight or a tag past the image's `![`. Export joins alt text that the Markdown wraps across lines with a space, as in a paragraph, and gives Word a hard break as a line break.
- **Syntax format**: The original Markdown syntax (attribute syntax or HTML `<img>`) is restored on re-import via the `MANUSCRIPT_IMAGE_FORMATS` metadata.
- **Deduplication**: Multiple references to the same image file produce a single `word/media/` entry in the DOCX.
- **Links**: An image in a link, alone as in `[![alt](a.png)](https://example.com)` or with text as in `[see ![alt](a.png) here](https://example.com)`, exports inside the link's `<w:hyperlink>`, and its `<wp:docPr>` holds an `<a:hlinkClick>` to the same place, as Word writes a linked picture. Import reads the link from either.

## Citation Key Formats

Configurable via `manuscriptMarkdown.citationKeyFormat`:

| Format | Example | Description |
|--------|---------|-------------|
| `authorYearTitle` (default) | `smith2020effects` | Author surname + year + first title word |
| `authorYear` | `smith2020` | Author surname + year |
| `numeric` | `1`, `2`, `3` | Sequential numbers |

Each cited item gets one key, wherever it's cited. Import tells Zotero items apart by their URI, or by their ID where a field has no URI, as Zotero does. Fields that share any URI cite one item, as after a sync or a merge, where Zotero lists an item's earlier URIs after its own. Citations of one item share its key and its `.bib` entry, which takes the data of the field that has the most, as a field can have less or none. When two items would get the same key, as with the same author, year and title, the second gets a number after it, as in `smith2020effects2`.

## Usage

1. Right-click a `.docx` file in VS Code Explorer
2. Select **Export to Markdown**
3. Output: `filename.md` and `filename.bib` (if citations present)

Or use the command palette and select a file via dialog.

If output files already exist, you'll be prompted to replace, choose a new name, or cancel.

## Known Limitations

- **Complex nested tables**: nested `<table>` elements inside cells are not supported
- **Task-list round-trip normalization**: task list items are exported with deterministic checkbox prefixes in DOCX output. Import reads a `☐` or `☒` at the start of a list item, or of a paragraph indented the way export indents a bulleted task item, back as a task item. Exact original marker spelling (`[x]` vs `[X]`) is not preserved
- **Empty paragraphs**: Markdown reads any number of blank lines between two blocks as one, so import writes Word's empty paragraphs there as the blank line between them, and the next export has none. Before a quote, import writes a blank line for each, which export keeps in a custom property, and in a table cell written as HTML each is a `<p></p>`. A list item with no text stays an item, as `2. `
- **Spaces and tabs at a paragraph's end**: Word shows nothing for them, and Markdown drops them, so import leaves them out, in the body and in notes, and Word's text loses them. An HTML table cell's paragraph is the exception: import writes a space at its end as `&#32;`, which keeps it (see Tables). Other whitespace there, which Markdown trims too, as a no-break space, comes back as a character reference, `end&nbsp;`, and the spaces and tabs of a paragraph a tracked paragraph mark leaves alone stay too, as references. Before a display equation in the paragraph, which Word shows after them, spaces stay too, as references, `text&#32;&#32;` on the line before `$$`, as raw ones there would be dropped, one, or read as a line break, two.
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

**Comment on a citation's or cross-reference's text**

A citation, or a reference to a note that Word holds as a cross-reference to it, is one item in Markdown, with no text of its own a comment could start or end in. A comment Word anchors inside the text it shows for one, as on the citation's text or the note's number alone, takes in the whole citation or reference.

DOCX: comment on `Smith 2020` inside the citation `(Smith 2020)`

```markdown
{==[@smith2020]==}{>>check the year<<}
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

Some settings leave no trace in the Word document: `locale` and `zotero-notes` without Zotero citations, `notes` without notes, `timezone`, `blockquote-style`, `colors` and `breaks`. Export stores them in the `MANUSCRIPT_FRONTMATTER_SETTINGS_*` custom properties, and import restores each one unless the document itself says otherwise (Zotero's preferences, or the kind of notes it has). Where Zotero's preferences agree with a stored `locale` or `zotero-notes`, it comes back as written, even `locale: en-US` or `zotero-notes: in-text`, Zotero's defaults, which import otherwise leaves out. Without a stored `blockquote-style`, as in a document from Word, import writes the style most of the body's quote paragraphs are in, so that the fewest change style, and on a tie the one that comes first. Alerts don't count. Quotes in GitHub's style, the default, need no setting. Import reads `code-font` and `code-font-size` from the Code Block style, as it reads the other fonts from theirs. An explicit setting equal to the default, such as `code-font: Consolas`, isn't written back.

> **`zotero-notes` vs `notes`:** These fields are independent. `zotero-notes` controls how Zotero citations render (in-text, footnotes, or endnotes) and is stored in `ZOTERO_PREF_*` document properties for Zotero to read. `notes` controls whether the document's own footnote/endnote references are placed at the bottom of each page (footnotes) or collected at the end (endnotes). For example, a document can use `zotero-notes: in-text` for citations while using `notes: endnotes` for its own notes.

#### Bundled CSL styles

The following 18 styles are bundled and available without downloading:

`apa`, `bmj`, `chicago-author-date`, `chicago-notes-bibliography`, `chicago-shortened-notes-bibliography`, `modern-language-association`, `ieee`, `nature`, `cell`, `science`, `american-medical-association`, `american-chemical-society`, `american-political-science-association`, `american-sociological-association`, `vancouver`, `nlm`, `nlm-brackets`, `harvard-cite-them-right`

The Chicago note styles use the Chicago Manual of Style 18th-edition identifiers. Existing documents may continue to use `chicago-fullnote-bibliography` (mapped to `chicago-notes-bibliography`) or `chicago-note-bibliography` (mapped to `chicago-shortened-notes-bibliography`). These legacy identifiers remain accepted but are hidden from selectors and completions, and a DOCX roundtrip normalizes them to the corresponding Chicago 18 identifier.

If a style is not bundled, you will be prompted to download it from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Downloaded styles are cached in VS Code's global storage for reuse across workspaces.

### Template Support

When using **Export to Word with Template**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing. A template from Word in another language gives its built-in styles IDs from the names it shows, as `berschrift1` for German's Überschrift 1 and `Standard` for Normal, and keeps their English names, as `heading 1`. Export finds those styles by name and refers to them by the template's IDs, for the headings, title, quotes, notes, comments and bibliography, and applies the font and spacing settings to them. Where the template has a style with the English ID, or one that differs from it only in case, export uses that style. Either way it looks only at the template's styles of the built-in style's type: character styles for the note and comment reference marks, and paragraph styles for the rest. The template's own references to another style of an English ID, as a character style's base `Normal` where that's a character style, stay as they are.
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions, with the images of its picture bullets. Bullets take the template's numId 1 and numbers its numId 2 where those are a bullet and a number. Where they aren't, export adds its own definitions and leaves the template's in place for its headers, footers and styles.
- the page setup of its last section, such as its page size, margins and page number format
- its headers and footers, with their images, their fields such as a page number, and their lists' numbering. A DOCPROPERTY field keeps the custom property it shows. A field that shows a built-in property, such as Title or Author, shows the exported document's.

The template controls appearance while the Markdown controls content. Export reads the template's parts in the encoding their byte-order mark or XML declaration names, as UTF-16, and writes a part it changes, as `word/styles.xml`, in UTF-8, which its declaration then says. A part it takes as it is stays in its encoding.

Export takes the headers and footers that the template's last section shows, its first-page and even-page ones included. The first page gets its own header and footer if the template's first section has a different first page, and even pages get theirs if the template turns even-page headers on. The headers and footers start on the document's first page, the only one treated as a first page, and continue through the sections that orientation directives add. Those sections take the page number format too, and their pages count on from the document's first page, which takes the page number start of the template's first section, or else of its last. Import doesn't put headers and footers in the Markdown, so a document keeps them through Word → Markdown → Word only when the export's template has them. **Export to Word** uses the existing `.docx` as that template.
