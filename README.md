# THIS REPO IS NOW ARCHIVED
This was my first and only extension for VSCode, which I somehow was able to put together with very little knowledge of JavaScript/TypeScript, VSCode and git/github (seems the `src` folder is missing but I'm *pretty* sure I never touched `.gitignore`). I suspect the code is quite horrible. My engagement with VSCode was very brief as I quite quickly moved onto vim and then Emacs. I was unaware of any interest in the extension, though now I see there's some open issues (I guess I never got any notifications?). Thank you for the interest shown, and sorry for the lack of attention!

#  CriticMarkup for Visual Studio Code README

A [CriticMarkup](http://criticmarkup.com/) extension for Visual
Studio Code.

## Features

Implements support for CriticMarkup in Visual Studio Code.

- Snippets with key bindings for suggesting additions, deletions and
  substitutions, as well as for commenting and highlighting.
- Adds grammars and syntax highlighting
- Cycle through changes in the document
- Full support for multi-line CriticMarkup patterns

## Requirements

This extension doesn't have any requirements or dependencies. However,
to convert the text you'll need converter.

## Usage

See the official [CriticMarkup User's Guide](http://criticmarkup.com/users-guide.php)
for a full introduction.

Use the following key bindings to insert CriticMarkup markup:

- Addition (`ctrl+shift+a`): Suggest an addition to the text.
- Deletion (`ctrl+shift+d`): Suggest text to be deleted (will markup
  currently selected text).
- Substitution (`ctrl+shift+s`): Suggest that text be substituted for
  other text (will markup the currently selected text as text to be
  substituted).
- Comment (`ctrl+shift+c`): Add a comment.
- Highlight and comment (`ctrl+shift+h`): Highlight and comment the
  text (selected text will be highlighted).

To cycle between changes, use the Command Palette and the commands
`CriticMarkup: Next Change` and `CriticMarkup: Previous Change`.

### Multi-line Support

All CriticMarkup patterns fully support spanning multiple lines, including patterns with empty lines within them. This allows you to mark up entire paragraphs or sections:

**Addition spanning multiple lines:**
```
{++
This is a new paragraph that spans
multiple lines.

It can even include empty lines between paragraphs.
++}
```

**Deletion of multiple paragraphs:**
```
{--
Remove this entire section
including multiple paragraphs.

This will all be marked as deleted.
--}
```

**Multi-line substitution:**
```
{~~
Old text that spans
multiple lines
~>
New replacement text
that also spans multiple lines
~~}
```

**Multi-line comments:**
```
{>>
This is a detailed comment
that provides extensive feedback
across multiple lines.
<<}
```

**Multi-line highlights:**
```
{==
Highlight this important section
that spans multiple lines
for review.
==}
```

The extension handles multi-line patterns correctly in:
- Syntax highlighting in the editor
- Navigation commands (next/previous change)
- Markdown preview rendering

## Extension Settings

The syntax highlight colors can be changed by modifying the following
`textMateRules` under `editor.tokenColorCustomizations` in
`settings.json`:

- `criticmarkup.addition` (default `#00bb00`)
- `criticmarkup.deletion` (default `#dd0000`)
- `criticmarkup.substitution`(default `#ff8600`)
- `criticmarkup.comment` (default `#0000bb`)
- `criticmarkup.highlight` (default `#aa53a9`)

## Known Issues

- The extension will automatically set syntax highlighting colors for
  the CriticMarkup syntax. It will do so only if these setting aren't
  already set. Currently, only one setting is checked
  (`criticmarkup.addition`); if some settings are removed but not
  this, the extension won't reset the settings.

- Currently, the extension does not work very well with Markdown All
  in One and other extensions that implements strikethrough text.
  Since substitutions in CriticMarkup use the syntax `{~~foo~>bar~~}`,
  and the strikethrough syntax is `~~foo~~`, the substitution will
  appear as strikethrough text. If you still want to use this
  extension together with Markdown All in One, it is recommended that
  you disable the "syntax decorations" option.

- The key bindings probably conflict with other key bindings. Please
  let know.

## Limitations

- **Performance**: While the extension handles multi-line patterns efficiently for typical documents, very large documents (10,000+ lines) with many complex multi-line patterns may experience slight delays in syntax highlighting or navigation.

- **Nested patterns**: CriticMarkup patterns cannot be nested within each other. If you attempt to nest patterns (e.g., `{++outer {--inner--}++}`), only the outer pattern will be recognized.

- **Unclosed patterns**: If you start a CriticMarkup pattern but don't close it (e.g., `{++text without closing`), the pattern will not be recognized as valid CriticMarkup. Navigation commands will not find it, and in the preview it will appear as literal text. The syntax highlighting behavior depends on VS Code's TextMate engine and may continue highlighting until it finds a closing marker or reaches an internal limit.

## Todo

- [ ] Automatically distinguish between highlighting and commenting,
      and just commenting
- [ ] Accept/reject changes
- [x] Jump to changes
- [ ] Track changes functionality

## Release Notes

## [0.2.0] - 2019-04-27

- Implemented functionally to go to next/previous change
- Tidied up code and repository

### [0.1.1] - 2019-04-16

- Improved support for markup that extends over multiple lines.

### [0.1.0] - 2019-03-28

- Initial release.
