# Zotero Citation Roundtrip

This guide covers the full roundtrip workflow for Zotero citations: importing a Word document, editing in Markdown, and exporting back to a DOCX that Zotero can manage. For a quick reference of all converter features, see [DOCX Converter](converter.md).

## The Roundtrip Workflow

The converter preserves Zotero citation identity through the entire cycle:

```text
  DOCX (with Zotero citations)
    │
    ▼
  Export to Markdown
    ├── article.md    (text + citation syntax + YAML frontmatter)
    └── article.bib   (BibTeX with Zotero identity fields)
    │
    ▼
  Edit in VS Code
    (add, remove, reorder citations; revise text)
    │
    ▼
  Export to Word
    └── article.docx  (Zotero field codes + formatted bibliography)
```

At each step:

1. **DOCX → Markdown**: Zotero field codes are parsed. Each citation's item key and URI are saved to BibTeX. Citation text becomes parenthetical (`[@key]`), narrative (`@key`), or suppress-author (`[-@key]`) syntax when it can be represented safely. Document preferences (CSL style, locale, Zotero note type) become YAML frontmatter.
2. **Editing**: You work with standard Pandoc citation syntax in Markdown. The BibTeX file holds the Zotero metadata alongside the bibliographic data.
3. **Markdown → DOCX**: Citations are reconstructed as Zotero `ADDIN ZOTERO_ITEM` field codes. The CSL style formats visible citation text and bibliography. Document preferences are written back so Zotero recognizes the file.

## Editing Citations in Markdown

Citations use [Pandoc citation syntax](https://pandoc.org/chunkedhtml-demo/8.20-citation-syntax.html):

| Syntax | Meaning |
|--------|---------|
| `@smith2020` | Author-in-text or narrative citation |
| `[@smith2020]` | Parenthetical citation |
| `[-@smith2020]` | Parenthetical citation with the author suppressed |
| `[@smith2020; @jones2021]` | Grouped citation (one Zotero field) |
| `[@smith2020, p. 20]` | Citation with page locator |
| `[@smith2020, pp. 20-25]` | Citation with page range |

**Grouped citations**: Semicolons group multiple references into a single Zotero field code. When Zotero manages the exported document, it treats `[@smith2020; @jones2021]` as one citation cluster — the same as if you had inserted both references together in Word.

**Locators**: Page numbers and other locators are written in the Markdown citation, not in the BibTeX file. This matches how Zotero handles them — a locator belongs to a specific citation instance, not to the bibliographic entry itself. Supported locator terms follow Pandoc conventions: `p.`, `pp.`, `ch.`, `sec.`, `vol.`, etc.

### Narrative citation fields

A resolved bare `@key` exports as a single Zotero citation field with composite mode, allowing compatible author-date styles to render text such as `Smith (2020)`. If the CSL style cannot safely render a composite citation, as with numeric styles, the converter writes the author as literal text followed by an ordinary suppress-author Zotero field. The visible result is preserved, but that fallback is not a lossless composite round-trip.

On DOCX import, a composite field becomes bare `@key` only when it contains exactly one citation item with no locator, suppress-author flag, prefix, suffix, infix, author-only mode, or other unsupported item mode. Grouped or decorated composite fields fall back to their visible Word field result rather than producing incorrect narrative syntax.

## BibTeX and Zotero Identity

When the converter extracts citations from a Zotero-managed DOCX, it adds two custom fields to each BibTeX entry:

```bibtex
@article{bearak2020unintended,
  author = {Bearak, Jonathan and Popinchalk, Anna and Ganatra, Bela},
  title = {{Unintended pregnancy and abortion by income, region,
            and the legal status of abortion}},
  journal = {The Lancet Global Health},
  volume = {8},
  pages = {e1152--e1161},
  year = {2020},
  doi = {10.1016/S2214-109X(20)30315-6},
  zotero-key = {P5EYVHT4},
  zotero-uri = {http://zotero.org/users/local/ibWt60LF/items/P5EYVHT4},
}
```

- **`zotero-key`**: The 8-character item key that identifies this entry in your Zotero library.
- **`zotero-uri`**: The full Zotero URI, which includes the library type (local, synced user, or group) and the item key.

These fields are what allow the converter to reconstruct Zotero field codes on export. **Do not remove them** if you want the exported DOCX to be Zotero-manageable. Standard BibTeX parsers ignore unknown fields, so these are safe to keep.

All other BibTeX fields (author, title, etc.) are standard CSL-JSON-derived data that Zotero originally embedded in the field code.

Citation key format is configurable — see [Citation Key Formats](converter.md#citation-key-formats).

## YAML Frontmatter

When a DOCX has Zotero document preferences, the converter extracts them as YAML frontmatter:

```yaml
---
csl: apa
locale: en-US
zotero-notes: in-text
---
```

| Field | Description |
|-------|-------------|
| `csl` | CSL style short name (e.g., `apa`, `chicago-author-date`, `bmj`) or path to a `.csl` file (relative or absolute) |
| `locale` | Optional locale override (e.g., `en-US`, `en-GB`). Defaults to the style's own locale. |
| `zotero-notes` | Optional Zotero note type: `in-text` (default), `footnotes`, or `endnotes`. Legacy alias: `note-type`. Legacy numeric values (0, 1, 2) are still accepted. |
| `nocite` | Manually authored bibliography-only keys; `@*` includes all available entries. This is not inferred from Zotero's existing `uncited` metadata. |

You can also add or modify this frontmatter manually. The `csl` field is required for CSL-formatted citation output — without it, citations use a plain-text `(Author Year)` fallback.

### Uncited bibliography entries

`nocite` is bibliography-only: it adds no `ZOTERO_ITEM CSL_CITATION` fields. Explicit missing keys warn and stay invisible; `@*` includes all available entries. Visible citations are registered first, explicit `nocite` keys next, and wildcard-only entries last, so bibliography-only entries do not renumber visible citations.

For `nocite` entries with real Zotero item URIs, the exporter records those URIs in the `ZOTERO_BIBL` field's `uncited` metadata and merges carried-through `uncited`, `omitted`, and `custom` arrays. This prior metadata is preserved only when a caller passes the imported `zoteroBiblData` back to the exporter; the current extension and CLI do not store it in Markdown for a later separate export.

A local-only BibTeX entry without a Zotero URI still appears in the initially rendered bibliography, but it cannot be added to Zotero's `uncited` metadata and has no in-text field carrying embedded item data. A later Zotero refresh may therefore be unable to reconstruct that bibliography-only entry.

## CSL Citation Styles

### Bundled styles

These 16 styles are available without downloading:

`apa`, `bmj`, `chicago-author-date`, `chicago-fullnote-bibliography`, `chicago-note-bibliography`, `modern-language-association`, `ieee`, `nature`, `cell`, `science`, `american-medical-association`, `american-chemical-society`, `american-political-science-association`, `american-sociological-association`, `vancouver`, `harvard-cite-them-right`

### Style resolution

When the converter needs a CSL style, it checks in order:

1. **Bundled styles** shipped with the extension
2. **Cached styles** previously downloaded (stored in VS Code's global storage)
3. **Download prompt** — you're asked whether to download from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Downloaded styles are cached for future use.
4. **Fallback** — if you decline or the download fails, citations are exported as plain text and a warning is shown.

### Using a local CSL file

Set `csl` to a file path instead of a style name. Relative paths are resolved relative to the markdown file's directory:

```yaml
---
csl: custom-journal.csl
---
```

Absolute paths also work:

```yaml
---
csl: /Users/me/styles/custom-journal.csl
---
```

## What Zotero Sees After Export

When you export back to DOCX with a `csl` field in frontmatter, the converter produces a document that Zotero can recognize and manage:

- **Document preferences**: The `csl`, `locale`, and `zotero-notes` values are written to `docProps/custom.xml` as `ZOTERO_PREF_*` properties (Zotero's dataVersion 4 format). This tells the Zotero Word plugin which citation style and settings the document uses.
- **Citation field codes**: Each citation becomes an `ADDIN ZOTERO_ITEM CSL_CITATION` field code containing full CSL-JSON item data, item URIs, and any locators — the same structure Zotero itself writes.
- **Bibliography field**: A `ZOTERO_BIBL` field code is appended at the end of the document with the rendered bibliography and, when available, real Zotero URIs for bibliography-only `nocite` entries in its `uncited` metadata.

After opening the exported DOCX in Word, Zotero's plugin can refresh citations, change the citation style, or add new references as usual.

## Troubleshooting

### Zotero Word extension prompts you to choose a citation style

Make sure the Markdown frontmatter includes a `csl` field. Without it, the converter doesn't write Zotero document preferences to the DOCX.

### CSL style not found

If you see a download prompt, the style isn't bundled. You can download it (it will be cached), or check that the style name matches one from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Common mistake: using a display name like "APA 7th Edition" instead of the short name `apa`.

### Word shows unsaved changes after opening a citation document

Documents with Zotero citation field codes (or tables) may be marked as modified by Word on open. This is a Word behavior — Word recalculates citation fields and table column widths during open, which sets the unsaved-changes flag. Even re-opening a document that was saved by Word itself shows the same behavior. This affects documents generated by Manuscript Markdown, Zotero, or any other tool that uses Word citation field codes.

### Wrong citation format

Verify the `csl` frontmatter field matches the style you expect. If you're getting author-date output but want numeric, switch to a numeric style (e.g., `vancouver`, `ieee`). If citations appear as plain `(Author Year)` without proper formatting, the CSL style may not have loaded — check for warning messages during export.

## References

- [Zotero Documentation: Word Field Codes](https://www.zotero.org/support/kb/word_field_codes)
- [Pandoc Citation Syntax](https://pandoc.org/chunkedhtml-demo/8.20-citation-syntax.html)
- [CSL Styles Repository](https://github.com/citation-style-language/styles-distribution)
- [Zotero Forums: Field Code Structure](https://forums.zotero.org/discussion/89432/why-field-code-in-ms-word-contain-so-much-informations)
- [Office Open XML: Field Codes](https://officeopenxml.com/WPfields.php)
