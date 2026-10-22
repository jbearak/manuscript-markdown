# Language Server

The language server provides IDE features for pandoc-style citations (`[@citekey]`) in markdown files paired with `.bib` files, for cross-references to figures and tables (`@fig-map`), and hover information for non-inline comments.

## Capabilities

### Completion (`@` trigger)

In a markdown file, typing `[@` inside brackets triggers autocomplete from the paired `.bib` file. Completions show:
- **Label**: the citekey (e.g. `smith2020`)
- **Detail**: author and year
- **Documentation**: title

A key no citation can cite, as one with a `;`, a `]` or a backtick, is left out (see [Diagnostics](#diagnostics)).

The server reads a citation's keys as Word export does: each key is the text after its `@` to the item's comma, so `[@smith.2020]` is the key `smith.2020`. It finds the `[` a citation starts at as export does too, so in `[text [@smith2020]]` the citation is the inner brackets. Brackets over more than one line, which export can read as more than one block, are read as before: each `@` starts a key of letters, digits, `_`, `:` and `-`.

A key that starts with `fig-` or `tbl-` is a cross-reference's, not a citation's, so the server reads no citation in brackets with one (see [Cross-References](#cross-references)).

### Diagnostics

- **In markdown**: a citation key the paired `.bib` file doesn't have is reported where it's cited.
- **In a `.bib` file**: a key no citation can cite is reported on the key, as one that starts with `fig-` or `tbl-`, a cross-reference's. A `;` or `]` in a key ends the citation's item or the citation there, and a backtick with another after it makes code of the text between, where the server reads no citation. An entry that gives a field more than once is reported on its key too: BibTeX reads the first value and warns of the rest, but biber and this extension read the last.

### Go to Definition

From a `[@citekey]` in markdown, navigates to the key's declaration in the `.bib` file.

### Find References

- **From markdown**: returns the `.bib` declaration location. Markdown-to-markdown references are provided by VS Code's built-in Markdown Language Features extension.
- **From `.bib`**: finds all `[@citekey]` usages across paired markdown files.

### Cross-References

The server reads a document's cross-references to its figures and tables as export does (see [Cross-References](specification.md#cross-references)), outside code and the frontmatter, with no `.bib` file. A label is a figure's or a table's where export captions one with it, as the preview does: after an image alone in its paragraph, or at the end of a table's caption. A `{#fig-…}` that labels nothing, as in a sentence or a list, is none.

- **Completion**: after an `@` that can start a cross-reference, as one not after a letter or a digit, the labels of the document's figures and tables, as `fig-map` from `{#fig-map}`, that what's typed starts, with the citation keys where a citation can start there too. After `@Fig-` or `@Tbl-`, a label comes as `Fig-map`.
- **Diagnostics**: a warning on a reference to a label no figure or table has, which Word gets as text, on a label a figure or table has after another, whose references go to the first, and on a citation's brackets with a cross-reference among other text, as `[-@fig-map]` or `[see @fig-map]`, which Word gets as text.
- **Go to Definition**: from a cross-reference, to the label of its figure or table, the first that has it.

### Comment Hover

When hovering over a non-inline comment body (`{#id>>...<<}`), the server displays the associated text — the content between the matching `{#id}` and `{/id}` range markers. CriticMarkup tags are stripped from the displayed text, and the result is rendered as Markdown.

## Bib file pairing

The LSP resolves which `.bib` file a markdown document is paired with using two mechanisms, in order:

1. **Frontmatter `bibliography` field** (aliases: `bib`, `bibtex`) — e.g. `bibliography: refs/library.bib`. Relative paths resolve from the `.md` file directory, then workspace root. `/`-prefixed paths resolve from workspace root, then as absolute OS paths. The `.bib` extension is added automatically if omitted.
2. **Same-basename fallback** — `paper.md` pairs with `paper.bib` in the same directory.

When finding references from a `.bib` file, paired markdown files are discovered via:
1. Same-basename `.md` file on disk
2. Open editor documents whose frontmatter `bibliography` resolves to the `.bib`

No workspace directory tree scanning is performed.

## Frontmatter Intelligence

The language server provides autocomplete, hover, and diagnostics inside YAML frontmatter blocks. See [Frontmatter reference](specification.md#yaml-frontmatter) for the full list of recognized keys.

### Key Autocomplete

Starting a new line or typing in a frontmatter block automatically offers all recognized keys, filtering out keys already declared in the block. Suggestions are available while the block is still being written, before its closing `---` delimiter is added.

### Value Autocomplete

Known keys offer contextual value completions:

- **Booleans** — `true` / `false`
- **Enums** — accepted values for the key (e.g., `single`, `1.5`, `double` for `line-spacing`)
- **Fonts** — platform-appropriate font suggestions (monospace fonts for `code-font`)
- **CSL styles** — bundled style names plus any previously downloaded styles
- **Font styles** — combinable parts like `bold`, `italic`, `smallcaps`

Typing `:` after a known key automatically opens its value choices, and the list keeps filtering as you type the value. Accepting a key completion also opens the same choices when the key has generated suggestions. You can still invoke completions manually with **Ctrl+Space**.

For comma-separated and inline-array font fields, accepting a suggestion replaces only the item under the cursor.

An item of a YAML block list, as `  - Georgia` after `header-font:`, gets the same hover and checks as a value written after its key, and the value completions an item of the key's inline array gets: fonts and font styles for `header-font`, `header-font-style`, `title-font` and `title-font-style`, and none under a key that takes one value, or under `table-col-widths`, whose `equal` and `auto` export reads only alone. An item that goes on past its line gets no value completions, and a value completed after a bare `-` gets a space before it. Suggestions open while you type the items of a list with its `-` unindented, as `- Arial` after `header-font:`, before the block's closing `---` is added, as they do for the keys after it.

### Hover

Hovering on a recognized key shows its description, accepted values, and aliases.

### Bibliography Link

The path after `bibliography:` (or `bib:` or `bibtex:`) is a link to the file: Cmd-click it (Ctrl-click on Windows and Linux) to open it. The link goes to the file the server pairs with the document, found as in [Bib file pairing](#bib-file-pairing), and only where that file exists. Under a block list, the link is on the item export reads. The same-basename fallback gets no link, as nothing in the frontmatter names it.

### Diagnostics

| Severity | Condition |
|----------|-----------|
| Error | Invalid value for a known key (e.g., `line-spacing: triple`) |
| Warning | Duplicate key (except `title`, which allows repeats) |
| Warning | An item past the first in a block list under a key that takes one value (`author:` then `- A` and `- B`), of which export uses only one |
| Warning | An item of a block list that's a mapping (`- name: Jane`), which export doesn't read |
| Warning | An item of a block list that goes on past its line, or opens a quote it doesn't close there, of which export reads only the line |
| Warning | CSL style not found locally (the converter will download it automatically) |
| Warning | Bibliography file not found |
| Information | Unknown key closely resembling a known one ("Did you mean `font-size`?") |
| Information | Case mismatch (`Title` → "Frontmatter keys are case-sensitive. Did you mean `title`?") |

Unrecognized keys that do not closely resemble a known key are silently accepted — Manuscript Markdown does not flag unknown frontmatter keys, since YAML frontmatter is shared by many tools.

### `styles:` Block

Completions, hover, and diagnostics also work inside the `styles:` nested block for sub-properties: `font`, `font-size`, `font-style`, `spacing-before`, `spacing-after`, `paragraph-indent`.

### CSL Auto-Download

Non-bundled CSL styles are downloaded automatically by the converter when you run it. Once downloaded, the style appears in the autocomplete list alongside bundled ones.

### Case Sensitivity

Frontmatter keys are case-sensitive — `Title` is not the same as `title`. The language server flags case mismatches as informational diagnostics.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `manuscriptMarkdown.enableCitekeyLanguageServer` | boolean | `true` | Enable/disable all language server features |
| `manuscriptMarkdown.citekeyReferencesFromMarkdown` | boolean | `false` | Include markdown usages in Find All References when invoked from a markdown file. Off by default because VS Code's built-in Markdown Language Features already reports these |
