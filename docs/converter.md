# DOCX Converter

The DOCX converter transforms Microsoft Word documents into Manuscript Markdown format, preserving formatting, comments, citations, and equations.

## Round-Trip Features

The converter supports DOCX → Markdown → DOCX round-tripping. The following features are preserved in both directions:

- **Title**: `title:` frontmatter ↔ Word `Title`-styled paragraphs (multiple entries supported)
- **Author**: `author:` frontmatter ↔ `dc:creator` in Document Properties (omitted if blank)
- **Text formatting**: Markdown syntax ↔ Word run formatting (bold, italic, underline, strikethrough, superscript, subscript, inline code)
- **Headings**: `#`–`######` Markdown headings ↔ Word heading styles (H1 through H6)
- **Lists**: Markdown list syntax ↔ Word numbering (bulleted and numbered with nesting)
- **Comments**: non-overlapping comments use CriticMarkup `{==highlighted text==}{>>author: comment<<}` format; overlapping comments use non-inline ID-based syntax (`{#1}highlighted text{/1}{#1>>alice: comment<<}`) — see [Specification](specification.md#overlapping-comments)
- **Track changes**: CriticMarkup `{++...++}` and `{--...--}` ↔ Word revisions (`w:ins`/`w:del`)
- **Citations**: Zotero field codes ↔ Pandoc `[@key]` syntax with BibTeX export. On import, `ZOTERO_BIBL` field codes are detected and omitted (bibliography is regenerated on export). On export, bibliography is automatically generated and appended as a `ZOTERO_BIBL` field when a CSL style is specified. Mixed Zotero/non-Zotero grouped citations always produce unified output — a single set of parentheses wrapping all entries (see [Zotero Round-Trip](zotero-roundtrip.md#mixed-citations)). Missing keys appear inline as `@citekey` with a post-bibliography note.
- **Zotero document preferences**: CSL style, locale, and note type round-tripped between YAML frontmatter (`csl`, `locale`, `zotero-notes`) and `docProps/custom.xml` (`ZOTERO_PREF_*` properties)
- **Math**: OMML equations ↔ LaTeX (`$inline$` and `$$display$$`)
- **Hyperlinks**: Markdown links ↔ Word hyperlinks (with proper escaping)
- **Highlights**: colored highlights ↔ `==text=={color}` syntax
- **Blockquotes**: `> quoted text` ↔ Word Quote/Intense Quote paragraph style (with nesting)
- **Tables**: DOCX→Markdown import produces HTML tables (`<table>/<tr>/<th>/<td>`) to preserve multi-paragraph cell content; Markdown→DOCX export accepts both HTML tables and pipe-delimited tables (with `colspan` and `rowspan` support)
- **Code blocks**: fenced code blocks (`` ``` ``) ↔ Word "Code Block" paragraph style. Language annotations (e.g., `` ```stata ``) preserved via `MANUSCRIPT_CODE_BLOCK_LANGS` custom property. Inline code (`` `text` ``) uses the `CodeChar` character style (Consolas font, same as code blocks).
- **Footnotes/endnotes**: `[^label]` references and `[^label]: text` definitions ↔ Word footnotes/endnotes. Named labels preserved via `MANUSCRIPT_FOOTNOTE_IDS` custom property. See [Specification](specification.md#footnotes).

## LaTeX Equations

The converter translates between LaTeX math notation in Markdown and Microsoft Word's OMML (Office Math Markup Language) equation format. Conversion is bidirectional: DOCX import translates OMML to LaTeX, and Markdown export translates LaTeX back to OMML. See [LaTeX Equations](latex-equations.md) for the full syntax reference.

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

### Architecture

The converter is implemented in two modules:

| File | Direction | Entry point |
|------|-----------|-------------|
| `src/latex-to-omml.ts` | LaTeX → OMML | `latexToOmml(latex: string): string` |
| `src/omml.ts` | OMML → LaTeX | `ommlToLatex(children: any[]): string` |

Both modules use their own mapping tables (Unicode ↔ LaTeX, accent characters, n-ary operators) that are kept in sync. The LaTeX-to-OMML direction uses a tokenizer and recursive-descent parser; the OMML-to-LaTeX direction walks the parsed XML tree using fast-xml-parser.

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
- **Images**: Not extracted from DOCX

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
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`, `bmj`) or absolute path to a `.csl` file |
| `locale` | Optional locale override (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `zotero-notes` | Optional Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy alias: `note-type`. Legacy numeric values (0, 1, 2) are still accepted. |
| `notes` | Controls footnote/endnote generation: `footnotes` (default) or `endnotes`. Auto-detected on DOCX import. |
| `timezone` | Local timezone offset (e.g., `+05:00`, `-05:00`). Auto-generated on DOCX import for idempotent date roundtripping. |
| `bibliography` | Path to a `.bib` file (`.bib` extension optional). Aliases: `bib`, `bibtex`. See [Specification](specification.md#bibtex-companion-file). |

> **`zotero-notes` vs `notes`:** These fields are independent. `zotero-notes` controls how Zotero citations render (in-text, footnotes, or endnotes) and is stored in `ZOTERO_PREF_*` document properties for Zotero to read. `notes` controls whether the document's own footnote/endnote references are placed at the bottom of each page (footnotes) or collected at the end (endnotes). For example, a document can use `zotero-notes: in-text` for citations while using `notes: endnotes` for its own notes.

#### Bundled CSL styles

The following 16 styles are bundled and available without downloading:

`apa`, `bmj`, `chicago-author-date`, `chicago-fullnote-bibliography`, `chicago-note-bibliography`, `modern-language-association`, `ieee`, `nature`, `cell`, `science`, `american-medical-association`, `american-chemical-society`, `american-political-science-association`, `american-sociological-association`, `vancouver`, `harvard-cite-them-right`

If a style is not bundled, you will be prompted to download it from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Downloaded styles are cached in VS Code's global storage for reuse across workspaces.

### Template Support

When using **Export to Word with Template**, the converter extracts styling parts from the template:

- `word/styles.xml` — heading fonts, body text formatting, spacing
- `word/theme/theme1.xml` — theme colors and fonts
- `word/numbering.xml` — list definitions
- `word/settings.xml` — document-level settings

The template controls appearance while the Markdown controls content.
