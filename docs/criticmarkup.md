# CriticMarkup Syntax

[CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) provides five operations for annotating text changes in Markdown documents.

## Operations

### Addition `{++text++}`

Marks text as newly added.

```markdown
This is {++newly added++} text.
```

### Deletion `{--text--}`

Marks text as deleted.

```markdown
This is {--removed--} text.
```

### Substitution `{~~old~>new~~}`

Marks text as replaced. The `~>` separates old text from new text.

```markdown
This is {~~old text~>new text~~}.
```

With one side empty, a substitution is a deletion or an insertion: `{~~old~>~~}` deletes `old`, and `{~~~>new~~}` inserts `new`. Import from DOCX writes a change this way when its text holds the change's own closer where a backslash can't escape it, as in code: `` {~~`--}`~>~~} ``. Where that side can't hold the code either, as the old side can't hold a `~>`, nor either side a `~~}`, the code goes in pieces split inside each closer, each in a change of its own: `` {--`a -`--}{--`-} b ~> c`--} ``, which export writes as the same deleted code. A change of all of a link that no change around the link can hold goes inside it, a change for each of the link's runs, or each piece of its code: `` [{~~`--}`~>~~}{--*~>*--}](https://example.com) ``.

### Comment `{>>text<<}`

Adds a comment annotation. With author attribution enabled, comments support `@Author | text` (author only) and `@Author (Date) | text` (author + timestamp).

```markdown
This needs review.{>>Consider rephrasing this section<<}
```

With attribution:
```markdown
{>>@alice (2024-01-15 14:30) | Consider rephrasing this section<<}
```

The `@` prefix and `|` separator make attribution unambiguous — comments like `{>>Note: this is important<<}` are never misparsed as having an author, since they don't start with `@`.

### Highlight `{==text==}`

Highlights text for attention.

```markdown
This is {==important==} text.
```

## Multi-line Support

All CriticMarkup patterns support multi-line content, including content with empty lines:

```markdown
{++This addition
spans multiple lines

including empty lines.++}
```

Blank lines inside additions and deletions separate paragraphs in the preview and Word export. Inline formatting continues across those paragraph boundaries. A single newline stays within the same paragraph.

A pipe table's cell holds one line, so a change over a line end can't start in one. Its opener there is text, and the table stays a table: in `| a {++ | b |`, the `{++` is text. An opener at the start of a table's first line, before its first cell's text, starts the change before the table, which then takes the table's lines as its text: `{>>a | b`, with `--- | ---` and `c | d<<}` on the lines after, is a comment. So is one in a table whose lines a change before it already takes. Lines in an equation that only look like a table, as between two `$$` lines, are the equation's, and a change over them works as anywhere in an equation.

An opener in raw HTML in a paragraph's or a heading's text, as in a comment or a tag's attribute, is the HTML's, so it starts no change: in `z <!-- {++ -->`, the `{++` is the comment's, and `{++real++}` on the next line is a change of its own. Where the HTML could be in an equation, which reads CriticMarkup in it, with a dollar sign before it and another after it anywhere in the document, the opener is read as before.

## Nesting Rules

- CriticMarkup patterns **cannot be nested** within the same type
- When patterns appear nested, only the first complete pattern is recognized
- Different CriticMarkup types can appear adjacent to each other (e.g., highlight followed by comment)

## Combined Operations

The extension provides combined commands that pair annotations with comments:

- **Comment and highlight**: `{==text==}{>>comment<<}`
- **Comment and mark as addition**: `{++text++}{>>comment<<}`
- **Comment and mark as deletion**: `{--text--}{>>comment<<}`
- **Comment and substitution**: `{~~old~>new~~}{>>comment<<}`

## Overlapping Comments

Standard CriticMarkup comments cannot overlap. Manuscript Markdown extends the syntax with ID-based comment ranges that support overlapping, nesting, and shared boundaries. See [Manuscript Extensions — Overlapping Comments](specification.md#overlapping-comments) for the full syntax reference.
