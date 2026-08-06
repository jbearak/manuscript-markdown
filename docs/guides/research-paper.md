# Writing Research Papers

Manuscript Markdown lets you write and revise papers in plain text while collaborating with colleagues who expect to use Word to comment on or suggest edits — and keep your work tracked in a Git repository.

## Document Structure

You can optionally include a YAML frontmatter block at the top of your document to set metadata:

```markdown
---
title: My Research Paper
csl: apa
---

# Abstract

...

# Introduction

...
```

### Metadata Fields

- `title`: The title of your paper.
- `csl`: The citation style to use (e.g., `apa`, `ieee`, `nature`). You can use any style from the [CSL repository](https://github.com/citation-style-language/styles).
- `nocite`: Bibliography entries to include without in-text citations; use `@*` for all available entries.
- `line-spacing`: Line spacing (`single`, `1.5`, `double`). Any non-`single` value other than the default 1.15 causes paragraphs to be automatically indented instead of separated by space — the standard academic manuscript format. Related keys: `paragraph-indent` (override the indent size in inches) and `bibliography-hanging-indent` (hanging indent for bibliography entries). See [Specification](../specification.md#line-spacing-and-paragraph-indent) for details.
- Text style customization: see [Configuration](../configuration.md) for options like fonts and spacing.

## Citations and Bibliography

Citations use standard [BibTeX](https://www.bibtex.org/) format, so you don't need to use Zotero at all. If you do use Zotero, the converter translates between BibTeX and Zotero field codes when importing and exporting Word documents.

### Inserting Citations

You can insert citations using standard Pandoc syntax:

- `@smith2020` -> Smith (2020), an author-in-text or narrative citation
- `[@smith2020]` -> (Smith, 2020), a parenthetical citation
- `[@smith2020; @jones2021]` -> (Smith, 2020; Jones, 2021), a citation cluster
- `[-@smith2020]` -> (2020), with the author suppressed

When you export to Word, these are converted to active Zotero citations. The Markdown preview continues to show the source syntax; CSL rendering is applied during Word export. Escape a literal handle as `\@username`; citation recognition also avoids structural locations such as code, HTML markup and comments, link destinations, and reference definitions.

### Managing the Bibliography

When you import a Word document that contains a bibliography, the converter automatically creates a companion `.bib` file alongside your `.md` file. If you prefer to manage your bibliography separately, specify the path in your frontmatter:

```markdown
---
bibliography: /path/to/my/references.bib
---
```

Use top-level `nocite` to add references to the bibliography without creating an in-text citation:

```yaml
---
nocite:
  - @smith2020
  - @jones2021
---
```

Use `nocite: @*` to include every available bibliography entry. Missing explicit keys produce a warning; the wildcard includes all available entries without missing-key warnings. See the [specification](../specification.md#nocite) for every supported YAML form.

## Equations

You can write LaTeX equations directly in your markdown:

- Inline: `$E = mc^2$`
- Display:
  ```latex
  $$
  \int_{0}^{\infty} x^2 dx
  $$
  ```

These are converted to native Word equations upon export.

## Collaboration

You can track changes using Git (commit history shows what changed between drafts) or using **CriticMarkup** annotations in the document itself — or both.

- Add: `{++added text++}`
- Delete: `{--deleted text--}`
- Substitute: `{~~old text~>new text~~}`
- Comment: `{>>comment<<}`

See the [CriticMarkup Guide](../criticmarkup.md) for more details.

