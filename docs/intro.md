# Getting Started

This guide is for academic writers who currently use Microsoft Word and want to try plain-text manuscript editing. It walks you through everything from installing VS Code to confidently using the Manuscript Markdown extension — no prior experience with code editors, Markdown, or git required.

The guide is organized in three parts:

1. **The Essentials** — install, write, and save. You can stop here and be productive.
2. **Making It Your Own** — fonts, preview, split editing, and import/export workflows.
3. **Going Deeper** — git diffs, additional syntax, and annotation markup.

---

## Part 1: The Essentials

### Installing VS Code

VS Code is a free text editor from Microsoft. Download it from [code.visualstudio.com](https://code.visualstudio.com) and run the installer.

> Several VS Code forks — such as Cursor, Google Antigravity, and Amazon Kiro — also work with this extension. If you already use one of those, you can skip this step.

### Installing the Extension

1. Download the latest `.vsix` file from the [releases page](https://github.com/jbearak/manuscript-markdown/releases)
2. In VS Code, open the Extensions sidebar — click the square icon on the left side, or press `Ctrl+Shift+X` (`Cmd+Shift+X` on Mac)
3. Click the `...` menu at the top of the Extensions sidebar and select **Install from VSIX...**
4. Navigate to the `.vsix` file you downloaded and select it

### Setting Up a Project Folder

VS Code works with folders, not individual files. Start by creating a folder on your computer for your project, then open it in VS Code: **File > Open Folder**.

There are two ways to start working:

- **From scratch**: In the Explorer sidebar (the file icon at the top-left), click the new-file icon and name your file with a `.md` extension (e.g., `paper.md`).

- **From a Word document**: Drag a `.docx` file into the folder — via Finder on Mac, File Explorer on Windows, or directly into VS Code's Explorer pane. Then right-click the `.docx` file in the Explorer sidebar and select **Export to Markdown**.

#### Keeping Word files out of git

If you drag `.docx` files into your project folder, you'll want to tell git to ignore them so they don't clutter your version history:

1. Click the new-file icon in the Explorer sidebar and name the file `.gitignore`
2. Add `*.docx` on the first line
3. Save the file (`Ctrl+S` / `Cmd+S`)

This tells git to skip all Word files in the folder.

### Initializing Git

Git is version history for your files — it tracks snapshots of your work so you can see what changed and go back if needed.

1. Click the **Source Control** icon in the sidebar (it looks like a branch)
2. Click **Initialize Repository**

That's it. Git is now tracking your project folder.

### Writing in Markdown

Markdown is a way of formatting text using plain characters. Here are the essentials:

#### Headings

```markdown
# Chapter Title
## Section
### Subsection
#### Sub-subsection
```

#### Text formatting

```markdown
**bold text**
_italic text_
==highlighted text==
==highlighted text=={red}
```

The highlight color is optional — without it, the default color (yellow) is used.

#### Citations

```markdown
[@smith2020]
[@smith2020, p. 20]
[@smith2020; @jones2021]
```

Citations reference entries in a companion `.bib` file. If you converted a Word document that had Zotero citations, this file was generated automatically.

#### Paragraphs

Separate paragraphs with a blank line. A single line break within text does not start a new paragraph.

#### Putting it all together

Here's what a short Markdown manuscript looks like. The block between the `---` lines at the top is optional metadata (called "frontmatter") — only the `title` field is shown here, but there are others for citation style, author, etc.

```markdown
---
title: The Nutritional Profile of Strawberries
---

# Introduction

Strawberries are one of the most widely consumed fruits in temperate
climates [@smith2019nutritional]. They are rich in vitamin C, manganese,
and a variety of antioxidant compounds [@smith2019nutritional, p. 34].

Recent studies have also linked regular strawberry consumption to
improved cardiovascular markers [@doe2021cardiovascular;
@roe2023berry]. However, the mechanisms underlying these effects
remain under investigation.
```

(These citations are placeholders — in a real document, the cite keys would come from your `.bib` file.)

See the [Specification](specification.md) for the full syntax reference.

### The Editor Toolbar

When a `.md` file is open, three dropdown menus appear as small icons in the top-right corner of the editor:

1. **Pencil icon** — **Markdown Formatting**: bold, italic, headings, lists, highlight colors, code, links, and table reflow.
2. **Speech-bubble icon** — **Markdown Annotations**: comments, tracked changes (additions, deletions, substitutions), and navigation between changes.
3. **Document icon** — **Export to Word**: export to Word, export with a template, and set citation style.

To use most of these commands, select some text first, then click the command from the menu.

See the [UI reference](ui.md) for the full menu reference.

### Saving Your Work with Git

Once you've made some edits, save a snapshot with git:

1. Save your file (`Ctrl+S` / `Cmd+S`)
2. Open the **Source Control** sidebar — click the branch icon on the left, or press `Ctrl+Shift+G` (`Cmd+Shift+G` on Mac)
3. Changed files appear under **Changes** — click the **+** icon next to a file to **stage** it (choose it for the snapshot)
4. Type a short message describing what you changed (e.g., "Draft introduction")
5. Click the **Commit** button (or press `Ctrl+Enter` / `Cmd+Enter`)

**Staging** means choosing which changes to include. **Committing** means saving the snapshot. You can commit as often as you like — each commit is a point you can return to later.

---

## Part 2: Making It Your Own

### Customizing Fonts

#### Editor font and size

1. Open Settings: `Ctrl+,` (`Cmd+,` on Mac), or **File > Preferences > Settings**
2. Search for **font family** — set **Editor: Font Family**
3. Search for **font size** — set **Editor: Font Size**

#### Markdown preview font and size

1. In the same Settings screen, search for **markdown preview font**
2. Set **Markdown > Preview: Font Family** and **Markdown > Preview: Font Size**

#### Recommended open-source fonts

Download and install a font on your system first, then enter its name in VS Code settings.

**For the editor** (monospace):

| Font | Description |
|------|-------------|
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Clean, tall lowercase, excellent readability; optional coding ligatures |
| [IBM Plex Mono](https://github.com/IBM/plex) | Neutral and professional; part of a matched family (Serif, Sans, Mono) |
| [Source Code Pro](https://github.com/adobe-fonts/source-code-pro) | Adobe's workhorse monospace; understated and reliable |

**For the preview** (proportional — serif or sans-serif):

| Font | Description |
|------|-------------|
| [Source Serif](https://github.com/adobe-fonts/source-serif) | Pairs naturally with Source Code Pro; comfortable for long reads |
| [Literata](https://github.com/googlefonts/literata) | Designed for long-form reading (originally for Google Play Books) |
| [IBM Plex Serif](https://github.com/IBM/plex) | Pairs with IBM Plex Mono; polished and contemporary |
| [Inter](https://github.com/rsms/inter) | Sans-serif; very clean on screen, good for UI-like preview feel |

### Previewing Markdown

- Click the **Open Preview to the Side** icon in the top-right of the editor (it looks like a book with a magnifying glass), or press `Ctrl+K V` (`Cmd+K V` on Mac)
- For a full-screen preview that replaces the editor tab, press `Ctrl+Shift+V` (`Cmd+Shift+V` on Mac)

The preview shows formatted text with highlights, annotations, and headings rendered visually.

### Splitting the Editor

You can view two parts of a document (or two different files) side by side:

- Click the **Split Editor** button in the top-right of the editor to split right
- `Alt`-click (`Option`-click on Mac) the same button to split down instead
- Or drag a tab to the side or bottom of the editor area

This is useful when you want to edit the Introduction in one pane and the Discussion in another.

### Navigating with the Outline

The breadcrumb bar at the top of the editor shows your current location in the document. Click any segment to see a list of headings — click one to jump there.

This is the quickest way to navigate a long manuscript.

### Importing and Exporting

The converter preserves text formatting, headings, citations, equations, tables, highlights, comments, and change tracking — all round-tripped in both directions between Markdown and Word.

#### Exporting to Word (Markdown to DOCX)

Two ways:

1. **Editor toolbar**: click the document icon > **Export to Word**
2. **Explorer sidebar**: right-click the `.md` file > **Export to Word**

If a `.docx` with the same name already exists, its formatting styles (fonts, spacing, colors) are automatically reused — so any changes you previously made to the Word file's appearance are preserved.

**Export to Word with Template** lets you pick any `.docx` file to use as a style template.

#### Exporting to Markdown (DOCX to Markdown)

Two ways:

1. **Editor toolbar**: when a `.docx` file is open, click the document icon > **Export to Markdown**
2. **Explorer sidebar**: right-click the `.docx` file > **Export to Markdown**

The converted `.md` file opens automatically. If the document contains citations, a companion `.bib` file is also generated and opens in a side-by-side tab.

See the [Converter documentation](converter.md) for full details.

---

## Part 3: Going Deeper

### Understanding the Git Diff View

After making changes, the Source Control sidebar shows modified files. Click a file there to see the **diff view**: the old version on the left and the new version on the right, with changes highlighted.

A few things to know about the diff view:

- To return to the normal editor, click the **Open File** button in the top-right of the editor (it looks like a file with an arrow), or simply open the file from the Explorer sidebar.
- You **can** edit directly in the diff view if you're looking at **unstaged** changes — the right side is editable.
- If the diff view won't let you type, you're looking at a **staged** change. Unstage it first (click the **−** icon in Source Control) or switch to the normal editor.

### More Markdown Syntax

Beyond the essentials in Part 1, Markdown supports:

```markdown
~~strikethrough~~
<u>underline</u>
[link text](https://example.com)
- bulleted list item
1. numbered list item
> blockquote
`inline code`
```

Fenced code blocks:

````markdown
```
code goes here
```
````

Footnotes:

```markdown
This sentence has a footnote[^1].

[^1]: The footnote text goes here.
```

Tables use pipes and dashes:

```markdown
| Column A | Column B |
|----------|----------|
| cell     | cell     |
```

See the [Specification](specification.md) for the full reference.

### Annotation Syntax

The toolbar buttons insert CriticMarkup — here's what the raw syntax looks like:

| Annotation | Syntax |
|------------|--------|
| Addition | `{++new text++}` |
| Deletion | `{--removed text--}` |
| Substitution | `{~~old text~>new text~~}` |
| Comment | `{>>comment text<<}` |
| Highlight | `{==highlighted text==}` |

You can type these directly instead of using the toolbar menus. See the [CriticMarkup documentation](criticmarkup.md) for full details.

### Right-Click Menus

Right-click inside the editor to see **Markdown Formatting** and **Markdown Annotations** submenus — these contain the same commands as the toolbar.

Right-click files in the Explorer sidebar for import/export commands (**Export to Markdown** for `.docx` files, **Export to Word** for `.md` files).
