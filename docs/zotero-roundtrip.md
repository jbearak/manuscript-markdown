# Zotero Citation Roundtrip

This guide covers the full roundtrip workflow for Zotero citations: importing a Word document, editing in Markdown, and exporting back to a DOCX that Zotero can manage. For a quick reference of all converter features, see [DOCX Converter](converter.md).

## The Roundtrip Workflow

The converter preserves Zotero citation identity through the entire cycle:

```text
  DOCX (with Zotero citations)
    │
    ▼
  Export to Markdown
    ├── article.md    (text + [@citations] + YAML frontmatter)
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

1. **DOCX → Markdown**: Zotero field codes are parsed. Each citation's item key and URI are saved to BibTeX. Citation text becomes `[@key]` syntax. Document preferences (CSL style, locale, Zotero note type) become YAML frontmatter.
2. **Editing**: You work with standard Pandoc citation syntax in Markdown. The BibTeX file holds the Zotero metadata alongside the bibliographic data.
3. **Markdown → DOCX**: Citations are reconstructed as Zotero `ADDIN ZOTERO_ITEM` field codes. The CSL style formats visible citation text and bibliography. Document preferences are written back so Zotero recognizes the file.

## Editing Citations in Markdown

Citations use [Pandoc citation syntax](https://pandoc.org/chunkedhtml-demo/8.20-citation-syntax.html):

| Syntax | Meaning |
|--------|---------|
| `[@smith2020]` | Single citation |
| `[@smith2020; @jones2021]` | Grouped citation (one Zotero field) |
| `[@smith2020, p. 20]` | Citation with page locator |
| `[@smith2020, pp. 20-25]` | Citation with page range |

**Grouped citations**: Semicolons group multiple references into a single Zotero field code. When Zotero manages the exported document, it treats `[@smith2020; @jones2021]` as one citation cluster — the same as if you had inserted both references together in Word.

**Locators**: Page numbers and other locators are written in the Markdown citation, not in the BibTeX file. This matches how Zotero handles them — a locator belongs to a specific citation instance, not to the bibliographic entry itself. Supported locator terms follow Pandoc conventions: `p.`, `pp.`, `ch.`, `sec.`, `vol.`, etc.

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

You can also add or modify this frontmatter manually. The `csl` field is required for CSL-formatted citation output — without it, citations use a plain-text `(Author Year)` fallback.

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
- **Bibliography field**: A `ZOTERO_BIBL` field code is appended at the end of the document with the rendered bibliography.

After opening the exported DOCX in Word, Zotero's plugin can refresh citations, change the citation style, or add new references as usual.

## Mixed Citations

When a BibTeX file contains both Zotero-linked entries (with `zotero-key` and `zotero-uri` fields) and plain entries (without Zotero metadata), the converter handles them differently:

- **Standalone citations**: A `[@zoteroEntry]` becomes a Zotero field code. A `[@plainEntry]` becomes plain formatted text.
- **Grouped citations**: If a group like `[@zoteroEntry; @plainEntry]` mixes Zotero and non-Zotero entries, the converter always produces unified output — a single set of parentheses wrapping all entries. Non-Zotero entries use synthetic URIs so Zotero gracefully falls back to embedded item data on refresh.

### Missing citation keys

If a citation key is not found in the BibTeX file (e.g., `[@noSuchKey]`), the converter:

1. Renders `@noSuchKey` inline so you can see what's missing
2. Appends a note after the bibliography: "Citation data for @noSuchKey was not found in the bibliography file."
3. Shows a VS Code warning message listing the missing keys

## Troubleshooting

### Citations not reconstructing as Zotero fields

Check that the BibTeX entry has both `zotero-key` and `zotero-uri` fields. These are added automatically during DOCX import but will be missing if you created the BibTeX entry manually or imported it from another tool.

### Zotero Word extension prompts you to choose a citation style

Make sure the Markdown frontmatter includes a `csl` field. Without it, the converter doesn't write Zotero document preferences to the DOCX.

### CSL style not found

If you see a download prompt, the style isn't bundled. You can download it (it will be cached), or check that the style name matches one from the [CSL styles repository](https://github.com/citation-style-language/styles-distribution). Common mistake: using a display name like "APA 7th Edition" instead of the short name `apa`.

### Wrong citation format

Verify the `csl` frontmatter field matches the style you expect. If you're getting author-date output but want numeric, switch to a numeric style (e.g., `vancouver`, `ieee`). If citations appear as plain `(Author Year)` without proper formatting, the CSL style may not have loaded — check for warning messages during export.

## References

- [Zotero Documentation: Word Field Codes](https://www.zotero.org/support/kb/word_field_codes)
- [Pandoc Citation Syntax](https://pandoc.org/chunkedhtml-demo/8.20-citation-syntax.html)
- [CSL Styles Repository](https://github.com/citation-style-language/styles-distribution)
- [Zotero Forums: Field Code Structure](https://forums.zotero.org/discussion/89432/why-field-code-in-ms-word-contain-so-much-informations)
- [Office Open XML: Field Codes](https://officeopenxml.com/WPfields.php)
