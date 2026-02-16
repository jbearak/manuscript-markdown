# Citekey Language Server

The citekey language server provides IDE features for pandoc-style citations (`[@citekey]`) in markdown files paired with `.bib` files.

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

## Bib file pairing

The LSP resolves which `.bib` file a markdown document is paired with using two mechanisms, in order:

1. **Frontmatter `bibliography` field** (aliases: `bib`, `bibtex`) — e.g. `bibliography: refs/library.bib`. Relative paths resolve from the `.md` file directory, then workspace root. `/`-prefixed paths resolve from workspace root, then as absolute OS paths. The `.bib` extension is added automatically if omitted.
2. **Same-basename fallback** — `paper.md` pairs with `paper.bib` in the same directory.

When finding references from a `.bib` file, paired markdown files are discovered via:
1. Same-basename `.md` file on disk
2. Open editor documents whose frontmatter `bibliography` resolves to the `.bib`

No workspace directory tree scanning is performed.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `manuscriptMarkdown.enableCitekeyLanguageServer` | boolean | `true` | Enable/disable all citekey language server features |
| `manuscriptMarkdown.citekeyReferencesFromMarkdown` | boolean | `false` | Include markdown usages in Find All References when invoked from a markdown file. Off by default because VS Code's built-in Markdown Language Features already reports these |
