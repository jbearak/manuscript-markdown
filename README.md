# mdmarkup - Markdown Annotations and Formatting for VS Code

mdmarkup extends VS Code with CriticMarkup support for tracking changes, suggestions, and comments in Markdown files.

> Download from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.mdmarkup) or install locally via `.vsix` from [releases](https://github.com/jbearak/mdmarkup/releases).

This is a major rewrite and expansion of the archived [vscode-criticmarkup](https://github.com/jloow/vscode-criticmarkup) extension (original by Joel Lööw, 2019). See [About This Fork](#about-this-fork) for details on what changed.

### Annotations

Move through annotations with:
- **Next Change**: `Alt+Shift+J` or toolbar button
- **Previous Change**: `Alt+Shift+K` or toolbar button

### Markdown Formatting

Click the **Markdown Formatting** button in the toolbar or right-click menu to access:
- **Text**: Bold, Italic, Bold Italic, Strikethrough, Underline, Inline Code
- **Lists**: Bulleted, Numbered, Task Lists
- **Blocks**: Code Block, Quote Block
- **Headings**: H1–H6
- **Links**: Insert Link
- **Tables**: Reflow with automatic column alignment
- **Word Count**: Display count for document or selection

## Installation

### VS Code Marketplace

Install directly from the [marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.mdmarkup).

### From VSIX

Download the `.vsix` from [releases](https://github.com/jbearak/mdmarkup/releases) and install:

```bash
code --install-extension mdmarkup-<version>.vsix
```

Or in VS Code: Extensions → `...` menu → "Install from VSIX..."

## Documentation

User guides:
- [Usage Guide](docs/usage.md) - Full feature documentation and examples
- [Configuration](docs/configuration.md) - All settings and customization options
- [CriticMarkup Reference](https://github.com/CriticMarkup/CriticMarkup-toolkit) - Markup syntax specification

Development and history:
- [Development Guide](docs/development.md) - Build, test, and contribution guide
- [Changelog](docs/CHANGELOG.md) - Release history and version notes

See also:
- [Known Issues and Limitations](#known-issues-and-limitations)

## Known Issues and Limitations

- **Multi-line preview rendering**: Multi-line CriticMarkup patterns only render correctly in preview when they start at the **beginning of a line**. Patterns that start mid-line (after other text on the same line) will not render in preview. However, **navigation commands work correctly** for patterns at any position.

- **TextMate syntax highlighting**: VS Code's TextMate grammar has inherent limitations with multi-line patterns. While syntax highlighting is provided, very long multi-line patterns may not highlight perfectly across all lines.

- **Nested patterns**: CriticMarkup patterns cannot be nested. If you attempt to nest patterns, only the first complete pattern is recognized.

- **Unclosed patterns**: Patterns without proper closing markup (e.g., `{++text without closing`) are not recognized as valid markup and appear as literal text.

## Development

See [Development Guide](docs/development.md) for building, testing, and contribution instructions.

For detailed development guidance including key invariants and learnings, see [AGENTS.md](AGENTS.md).

## Provenance

This project began as a fork of the archived [vscode-criticmarkup](https://github.com/jloow/vscode-criticmarkup) extension by Joel Lööw (2019), which provided basic CriticMarkup syntax highlighting and snippets. This version represents a complete architectural rewrite that extends the original with multi-line patterns, live preview, formatting tools, and comprehensive testing.

## Release History

See [Changelog](docs/CHANGELOG.md) for detailed release notes and version history.

## License

[GPLv3](LICENSE.txt) - See [LICENSE.txt](LICENSE.txt) for details.

## Credits

- **Original extension**: Joel Lööw
- **CriticMarkup specification**: Gabe Weatherhead and Erik Hess
- **Markdown specification**: John Gruber

## Contributing

Issues and pull requests are welcome. For significant changes, please open an issue first to discuss the proposed changes.

## Links

- [GitHub Repository](https://github.com/jbearak/mdmarkup)
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.mdmarkup)
- [CriticMarkup Official Site](https://github.com/CriticMarkup/CriticMarkup-toolkit)
- [Markdown Specification](https://daringfireball.net/projects/markdown/syntax)
