# Configuration

All settings are under the `manuscriptMarkdown` namespace in VS Code settings.

## Comment Attribution

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `includeAuthorNameInComments` | boolean | `true` | Include author name in comment attribution |
| `authorName` | string | `""` | Author name to use in comments (leave empty to use OS username) |
| `includeTimestampInComments` | boolean | `true` | Include timestamp in comment attribution (format: `yyyy-mm-dd hh:mm`) |

## Highlights

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultHighlightColor` | string | `"yellow"` | Default background color for `==highlight==` formatting when no color is specified. Options: `yellow`, `green`, `turquoise`, `pink`, `blue`, `red`, `dark-blue`, `teal`, `violet`, `dark-red`, `dark-yellow`, `gray-50`, `gray-25`, `black` |

## Citations

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `citationKeyFormat` | string | `"authorYearTitle"` | Citation key format for DOCX to Markdown conversion. `authorYearTitle` (e.g., smith2020effects), `authorYear` (e.g., smith2020), or `numeric` (e.g., 1, 2, 3) |
| `mixedCitationStyle` | string | `"separate"` | How to render mixed Zotero/non-Zotero grouped citations. `separate`: each portion gets its own parentheses (clean Zotero refresh). `unified`: one set of parentheses wrapping everything (looks like one group but may desync on Zotero refresh) |

## Language Server

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enableCitekeyLanguageServer` | boolean | `true` | Enable language server features: `@` completions, go-to-definition, find references for citation keys, and comment hover |
| `citekeyReferencesFromMarkdown` | boolean | `false` | Include markdown usages in Find All References when invoked from a markdown file. Off by default because VS Code's built-in Markdown Language Features already reports these; enabling this may produce duplicate entries |

## DOCX Conversion

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tableIndent` | integer | `2` | Number of spaces per indent level for HTML tables in DOCX to Markdown conversion |
| `blockquoteStyle` | string | `"Quote"` | Word paragraph style for blockquotes on MD→DOCX export: `Quote` or `IntenseQuote` |
