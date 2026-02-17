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

### Comment `{>>text<<}`

Adds a comment annotation. With author attribution enabled, comments include the author name and timestamp.

```markdown
This needs review.{>>Consider rephrasing this section<<}
```

With attribution:
```markdown
{>>alice (2024-01-15 14:30): Consider rephrasing this section<<}
```

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

**Limitation**: Multi-line patterns only render correctly in the Markdown preview when they start at the beginning of a line. Navigation commands work for patterns at any position.

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

Standard CriticMarkup comments cannot overlap. Manuscript Markdown extends the syntax with ID-based comment ranges that support overlapping, nesting, and shared boundaries. See [Custom Extensions — Overlapping Comments](custom-extensions.md#overlapping-comments) for the full syntax reference.
