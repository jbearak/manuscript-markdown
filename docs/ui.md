# User Interface

This document describes the menus, toolbar buttons, keyboard shortcuts, and messages you'll encounter when using the extension in VS Code.

> **Editor toolbar** — the row of small icons at the top-right corner of an open editor tab. The extension adds icons here that open dropdown menus. The icons only appear when the active file matches the relevant type (Markdown or Word).

## Editor Toolbar — Markdown Files

When a `.md` file is open, three dropdown menus appear in the editor toolbar. Each menu is a small icon; click it to open the dropdown.

> **Submenus** — some menu items have a small arrow (▸) on the right edge. Hover over them to reveal a nested list of choices.
>
> **Command IDs** — the tables below list the internal command ID for each item. You can use these IDs in the [Command Palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette) or to assign [custom keyboard shortcuts](https://code.visualstudio.com/docs/getstarted/keybindings).

---

### Markdown Formatting

> Look for the **pencil icon** (codicon `edit`) in the editor toolbar.

Text formatting, lists, and structure commands for Markdown editing.

| Group | Item | Command |
|-------|------|---------|
| Text formatting | **Bold** | `manuscript-markdown.formatBold` |
| | **Italic** | `manuscript-markdown.formatItalic` |
| | **Bold Italic** | `manuscript-markdown.formatBoldItalic` |
| | **Strikethrough** | `manuscript-markdown.formatStrikethrough` |
| | **Underline** | `manuscript-markdown.formatUnderline` |
| Highlight | **Highlight** | `manuscript-markdown.formatHighlight` |
| | **Highlight Color** ▸ | submenu — see below |
| Text formatting | **Inline Code** | `manuscript-markdown.formatInlineCode` |
| | **Code Block** | `manuscript-markdown.formatCodeBlock` |
| | **Link** | `manuscript-markdown.formatLink` |
| Lists | **Bulleted List** | `manuscript-markdown.formatBulletedList` |
| | **Numbered List** | `manuscript-markdown.formatNumberedList` |
| | **Task List** | `manuscript-markdown.formatTaskList` |
| | **Quote Block** | `manuscript-markdown.formatQuoteBlock` |
| Tables | **Reflow Table** | `manuscript-markdown.reflowTable` |
| Heading | **Heading** ▸ | submenu — see below |

> **Reflow Table** re-aligns a Markdown pipe table — the kind you build with `|` and `-` characters — so that the `|` column separators line up neatly. Place your cursor anywhere in the table and run the command.

#### Highlight Color submenu

The colors are shown in three groups, separated by divider lines. The group labels (Standard, Dark, Neutral) are used here for reference only — they don't appear as visible text in the VS Code menu.

| Group | Item | Command |
|-------|------|---------|
| Standard | **Yellow** | `manuscript-markdown.formatHighlight_yellow` |
| | **Green** | `manuscript-markdown.formatHighlight_green` |
| | **Turquoise** | `manuscript-markdown.formatHighlight_turquoise` |
| | **Pink** | `manuscript-markdown.formatHighlight_pink` |
| | **Blue** | `manuscript-markdown.formatHighlight_blue` |
| | **Red** | `manuscript-markdown.formatHighlight_red` |
| Dark | **Dark Blue** | `manuscript-markdown.formatHighlight_dark-blue` |
| | **Teal** | `manuscript-markdown.formatHighlight_teal` |
| | **Violet** | `manuscript-markdown.formatHighlight_violet` |
| | **Dark Red** | `manuscript-markdown.formatHighlight_dark-red` |
| | **Dark Yellow** | `manuscript-markdown.formatHighlight_dark-yellow` |
| Neutral | **Gray 50%** | `manuscript-markdown.formatHighlight_gray-50` |
| | **Gray 25%** | `manuscript-markdown.formatHighlight_gray-25` |
| | **Black** | `manuscript-markdown.formatHighlight_black` |

> The plain **Highlight** command uses the color set in `manuscriptMarkdown.defaultHighlightColor` (default: yellow). The **Highlight Color** submenu lets you pick a specific color. See [Configuration](configuration.md) for details.

#### Heading submenu

| Item | Command |
|------|---------|
| **Heading 1** | `manuscript-markdown.formatHeading1` |
| **Heading 2** | `manuscript-markdown.formatHeading2` |
| **Heading 3** | `manuscript-markdown.formatHeading3` |
| **Heading 4** | `manuscript-markdown.formatHeading4` |
| **Heading 5** | `manuscript-markdown.formatHeading5` |
| **Heading 6** | `manuscript-markdown.formatHeading6` |

---

### Markdown Annotations

> Look for the **speech-bubble icon** (codicon `comment-discussion`) in the editor toolbar.

Annotation and change-tracking commands — the Markdown equivalent of tracked changes and comments in MS Word. See [CriticMarkup](criticmarkup.md) for the underlying syntax.

| Group | Item | Command |
|-------|------|---------|
| Comments | **Comment** | `manuscript-markdown.comment` |
| | **Comment and Mark as Addition** | `manuscript-markdown.additionAndComment` |
| | **Comment and Mark as Deletion** | `manuscript-markdown.deletionAndComment` |
| | **Comment and Substitution** | `manuscript-markdown.substituteAndComment` |
| Markup | **Mark as Addition** | `manuscript-markdown.markAddition` |
| | **Mark as Deletion** | `manuscript-markdown.markDeletion` |
| | **Substitution** | `manuscript-markdown.markSubstitution` |
| Navigation | **Previous Change** | `manuscript-markdown.prevChange` |
| | **Next Change** | `manuscript-markdown.nextChange` |

---

### Export to Word

> Look for the **binary-file icon** (codicon `file-binary`) in the editor toolbar.

Export and citation-style commands. See [Converter](converter.md) for details on the conversion process.

| Group | Item | Command |
|-------|------|---------|
| Export | **Export to Word** | `manuscript-markdown.exportToWord` |
| | **Export to Word with Template** | `manuscript-markdown.exportToWordWithTemplate` |
| Style | **Set Citation Style** | `manuscript-markdown.setCitationStyle` |

> **Export to Word** converts the Markdown file to `.docx`. If a `.docx` with the same name already exists, its paragraph and formatting styles are automatically reused as a template — so fonts, spacing, and colors you previously set in Word are preserved.
>
> **Export to Word with Template** first opens a file picker so you can choose any `.docx` file whose paragraph formatting styles (fonts, sizes, spacing, colors) will be applied to the exported document.
>
> **Set Citation Style** does not export anything — it inserts or updates the `csl:` field in the document's YAML frontmatter, which controls how citations are formatted on the next export.

---

## Editor Toolbar — Word Documents

When a `.docx` file is open in the editor, one dropdown menu appears in the toolbar.

### Word Document

> Look for the **binary-file icon** (codicon `file-binary`) in the editor toolbar.

| Item | Condition | Command |
|------|-----------|---------|
| **Export to Markdown** | always | `manuscript-markdown.convertDocx` |
| **Open in Word** | local files only | `manuscript-markdown.openInWord` |

> **Open in Word** is hidden for remote workspaces (e.g., SSH, Codespaces) because it relies on launching a local application.

---

## Explorer Context Menu

> **Explorer pane** — the file-tree sidebar, usually on the left side of the VS Code window. **Context menu** means the menu that appears when you right-click a file.

Right-click a file in the Explorer to see these items:

| File type | Item | Command |
|-----------|------|---------|
| `.docx` | **Export to Markdown** | `manuscript-markdown.convertDocx` |
| `.docx` (local only) | **Open in Word** | `manuscript-markdown.openInWord` |
| `.md` | **Export to Word** | `manuscript-markdown.exportToWord` |
| `.md` | **Export to Word with Template** | `manuscript-markdown.exportToWordWithTemplate` |

---

## Editor Context Menu

> **Editor context menu** — the menu that appears when you right-click inside the text of an open file.

Right-clicking inside a Markdown editor shows two submenus at the bottom of the context menu:

| Submenu | Contents |
|---------|----------|
| **Markdown Annotations** | Same items as the [Markdown Annotations](#markdown-annotations) toolbar menu |
| **Markdown Formatting** | Same items as the [Markdown Formatting](#markdown-formatting) toolbar menu |

---

## Keyboard Shortcuts

> Keyboard shortcuts appear next to their menu items. You can customize them in VS Code via **File → Preferences → Keyboard Shortcuts** (or `Ctrl+K Ctrl+S` / `Cmd+K Cmd+S` on macOS).

| Shortcut | Command | Description |
|----------|---------|-------------|
| `Alt+Shift+J` | `manuscript-markdown.nextChange` | Jump to the next annotation |
| `Alt+Shift+K` | `manuscript-markdown.prevChange` | Jump to the previous annotation |

These shortcuts are active when a Markdown file has focus.

---

## Messages & Dialogs

> **Modal dialog** — a popup window that blocks the editor until you click one of its buttons. Non-modal messages appear briefly in the bottom-right corner.

### Export to Markdown (DOCX → MD)

The output is saved with the same base name as the source file (e.g., `report.docx` → `report.md`). If the document contains bibliographic data, a `.bib` file is also generated alongside it.

**Output file conflict** — if the target `.md` (or `.bib`) file already exists, a modal dialog asks what to do:

| Scenario | Message |
|----------|---------|
| `.md` exists | `"<name>.md" already exists in this folder. Replace it or save with a new name?` |
| `.bib` exists | `"<name>.bib" already exists in this folder. Replace it or save with a new name?` |
| Both exist | `"<name>.md" and "<name>.bib" already exist in this folder. Replace them or save with a new name?` |

Buttons: **Replace** · **New Name** · **Cancel**

Choosing **New Name** opens a save-as dialog so you can pick a different filename.

Once complete, the Markdown file opens in the editor. If a `.bib` file was generated, it opens in a side-by-side tab.

**Success** — `"Exported to Markdown successfully"`

**Error** — `"DOCX conversion failed: <error>"`

---

### Export to Word (MD → DOCX)

The output is saved with the same base name as the source file (e.g., `report.md` → `report.docx`). If a `.docx` with the same name already exists, its styles are automatically reused as a template so that fonts, spacing, and colors you set in Word are preserved.

**No active file** — if no Markdown file is open: `"No active Markdown file"`

**Bibliography not found** — when the frontmatter specifies a `bibliography` path that can't be resolved:

| Scenario | Message |
|----------|---------|
| Fallback `.bib` found | `Bibliography "<path>" not found; using <name>.bib` |
| No `.bib` at all | `Bibliography "<path>" not found and no default .bib file exists` |

> These warnings only appear when the Markdown file contains citations (i.e., `@citekey` references).

**CSL style not bundled** — if the frontmatter specifies a `csl` style that isn't included with the extension:

`CSL style "<name>" is not bundled. Download it from the CSL repository? Without it, citations will use plain-text fallback formatting.`

Buttons: **Download** · **Skip**

**Output file conflict** — if the target `.docx` already exists:

`"<name>.docx" already exists. Replace it or save with a new name?`

Buttons: **Replace** · **New Name** · **Cancel**

Choosing **New Name** opens a save-as dialog.

When the export finishes, a notification appears in the bottom-right corner with an **Open in Word** button (since `.docx` files aren't opened directly in the editor).

**Success** — `Exported to "<filename>"` with an **Open in Word** button.

**Success with warnings** — `Exported to "<filename>" with warnings: <warnings>` with an **Open in Word** button.

**Error** — `"Export to Word failed: <error>"`

---

### Export to Word with Template

Behaves the same as [Export to Word](#export-to-word-md--docx), but first shows a file-picker dialog to choose a `.docx` template file. "Choosing a template" means selecting an existing `.docx` file whose paragraph formatting styles — fonts, sizes, spacing, colors — will be applied to the exported document.

---

### Open in Word

| Scenario | Message |
|----------|---------|
| OS could not open | `"Failed to open file in external application."` |
| Other error | `"Failed to open file: <error>"` |

---

### Set Citation Style

> **Quick Pick** — VS Code's searchable dropdown list. Start typing to filter the options.

Shows a Quick Pick list of bundled CSL citation styles. Selecting a style inserts or updates the `csl:` field in the document's YAML frontmatter. If no frontmatter exists, one is created automatically.

If no Markdown file is open: `"No active Markdown file"`
