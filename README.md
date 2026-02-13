# mdmarkup - Markdown Annotations and Formatting

A [Markdown](https://daringfireball.net/projects/markdown/syntax) extension for Visual Studio Code with [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) support.

Download from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.mdmarkup) or install locally via `.vsix` from [releases](https://github.com/jbearak/mdmarkup/releases).

## Features

### Annotations

Click **Markdown Annotations** in the toolbar or right-click menu for:
- **Combined**: Comment and highlight, Comment and mark as addition, Comment and mark as deletion, Comment and substitution
- **Marks**: Highlight, Mark as Addition, Mark as Deletion, Substitution
- **Navigation**: Previous Change, Next Change

### Formatting

Click **Markdown Formatting** in the toolbar or right-click menu for:
- **Text**: Bold, Italic, Strikethrough, Code
- **Lists**: Bulleted, Numbered, Task Lists
- **Blocks**: Code Block, Quote Block
- **Headings**: H1–H6
- **Links & Tables**: Insert Link, Reflow Table with alignment

### Word Count

A word count indicator appears in the status bar, displaying the total word count of the current document or selected text.

### Configuration
- Customizable author name (defaults to OS username)
- Optional timestamps in comments

## Known Issues and Limitations

- **Multi-line preview rendering**: Multi-line patterns only render correctly in preview when they start at the **beginning of a line**. Patterns starting mid-line won't render, but **navigation commands work for patterns at any position**.

- **TextMate syntax highlighting**: VS Code's TextMate grammar has limitations with complex multi-line patterns. While syntax highlighting is provided, very long patterns may not highlight perfectly across all lines.

- **Nested patterns**: CriticMarkup patterns cannot be nested. Only the first complete pattern is recognized.

- **Unclosed patterns**: Patterns without proper closing markup (e.g., `{++text without closing`) appear as literal text.

## Development

See [Development](docs/development.md).

## License

Originally forked from [vscode-criticmarkup](https://github.com/jloow/vscode-criticmarkup) by Joel Lööw.

This project is open-source software licensed under [GPLv3](LICENSE.txt).
