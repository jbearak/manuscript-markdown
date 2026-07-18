# Language Server

The language server provides IDE features for pandoc-style citations (`[@citekey]`) in markdown files paired with `.bib` files, and hover information for non-inline comments.

## Capabilities

### Completion (`@` trigger)

In a markdown file, typing `[@` inside brackets triggers autocomplete from the paired `.bib` file. Completions show:
- **Label**: the citekey (e.g. `smith2020`)
- **Detail**: author and year
- **Documentation**: title

### Go to Definition

From a `[@citekey]` in markdown, navigates to the key's declaration in the `.bib` file.

### Find References

- **From markdown**: returns the `.bib` declaration location. Markdown-to-markdown references are provided by VS Code's built-in Markdown Language Features extension.
- **From `.bib`**: finds all `[@citekey]` usages across paired markdown files.

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

Typing in a frontmatter block offers all recognized keys, filtering out keys already declared in the block. Suggestions are available while the block is still being written, before its closing `---` delimiter is added.

### Value Autocomplete

Known keys offer contextual value completions:

- **Booleans** — `true` / `false`
- **Enums** — accepted values for the key (e.g., `single`, `1.5`, `double` for `line-spacing`)
- **Fonts** — platform-appropriate font suggestions (monospace fonts for `code-font`)
- **CSL styles** — bundled style names plus any previously downloaded styles
- **Font styles** — combinable parts like `bold`, `italic`, `smallcaps`

For comma-separated and inline-array font fields, accepting a suggestion replaces only the item under the cursor.

### Hover

Hovering on a recognized key shows its description, accepted values, and aliases.

### Diagnostics

| Severity | Condition |
|----------|-----------|
| Error | Invalid value for a known key (e.g., `line-spacing: triple`) |
| Warning | Duplicate key (except `title`, which allows repeats) |
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
