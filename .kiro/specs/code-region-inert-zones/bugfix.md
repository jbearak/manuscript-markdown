# Bugfix Requirements Document

## Introduction

CriticMarkup syntax (`{++`, `{--`, `{~~`, `{==`, `{>>`, `<<}`, etc.) and Manuscript Markdown extensions (format highlights `==text==`, `==text=={color}`, citations `[@key]`) are being parsed, decorated, and acted upon inside code regions — both inline code (backtick spans) and fenced code blocks (triple-backtick blocks). Code regions are inert zones in Markdown: their content is literal text and no markup syntax should be interpreted within them. This bug affects five subsystems: editor decorations, navigation, the preview renderer, the MD→DOCX converter, the DOCX→MD converter, and the language server (LSP).

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN CriticMarkup syntax (e.g., `{==highlighted==}`, `{++added++}`, `{--deleted--}`) appears inside an inline code span (`` `...` ``), THEN the system applies editor decorations (highlight colors, addition/deletion styling, delimiter muting) to that text as if it were live markup.

1.2 WHEN format highlight syntax (e.g., `==text==` or `==text=={color}`) appears inside an inline code span, THEN the system applies highlight decorations to that text.

1.3 WHEN CriticMarkup or format highlight syntax appears inside a fenced code block (`` ``` ``), THEN the system applies editor decorations to that text.

1.4 WHEN CriticMarkup or format highlight syntax appears inside a code region, THEN the navigation commands (next/previous change) stop on those matches as if they were real changes.

1.5 WHEN a Markdown file containing CriticMarkup syntax inside inline code or fenced code blocks is exported to DOCX, THEN the MD→DOCX converter interprets the CriticMarkup as live markup instead of preserving it as literal code text.

1.6 WHEN a DOCX document contains formatting (bold, italic, highlight, track changes) within a code-styled run or code block paragraph, THEN the DOCX→MD converter emits CriticMarkup or Markdown formatting syntax inside the code span instead of stripping the formatting.

1.7 WHEN a DOCX document contains a comment that begins AND ends entirely within a code region, THEN the DOCX→MD converter emits the comment annotation inside the code span where CriticMarkup syntax is invalid.

1.8 WHEN a DOCX document contains a comment that begins before a code region but ends within it, THEN the DOCX→MD converter emits the comment end marker inside the code span.

1.9 WHEN a DOCX document contains a comment that begins within a code region but ends after it, THEN the DOCX→MD converter emits the comment start marker inside the code span.

1.10 WHEN a citation key (e.g., `@smith2020`) appears inside an inline code span or fenced code block, THEN the language server provides completion suggestions, diagnostics, and reference results for it as if it were a real citation.

1.11 WHEN the markdown preview is rendered and CriticMarkup syntax appears inside a code region, THEN the preview plugin interprets and renders the CriticMarkup instead of showing it as literal text.

### Expected Behavior (Correct)

2.1 WHEN CriticMarkup syntax appears inside an inline code span, THEN the system SHALL NOT apply any editor decorations to that text; it SHALL be rendered as plain code.

2.2 WHEN format highlight syntax appears inside an inline code span, THEN the system SHALL NOT apply highlight decorations to that text.

2.3 WHEN CriticMarkup or format highlight syntax appears inside a fenced code block, THEN the system SHALL NOT apply any editor decorations to that text.

2.4 WHEN CriticMarkup or format highlight syntax appears inside a code region, THEN the navigation commands SHALL skip those matches entirely.

2.5 WHEN a Markdown file containing CriticMarkup syntax inside inline code or fenced code blocks is exported to DOCX, THEN the MD→DOCX converter SHALL treat the code content as literal text and export it with code styling only, without interpreting any CriticMarkup.

2.6 WHEN a DOCX document contains formatting within a code-styled run or code block paragraph, THEN the DOCX→MD converter SHALL strip all formatting and emit the text as plain code content.

2.7 WHEN a DOCX document contains a comment that begins AND ends entirely within a code region, THEN the DOCX→MD converter SHALL expand the comment to surround the entire code span (e.g., `{==` `` `code` `` `==}{>>comment<<}`), since CriticMarkup can surround but not be inside code regions.

2.8 WHEN a DOCX document contains a comment that begins before a code region but ends within it, THEN the DOCX→MD converter SHALL expand the comment end to fall outside (after) the code region.

2.9 WHEN a DOCX document contains a comment that begins within a code region but ends after it, THEN the DOCX→MD converter SHALL expand the comment start to fall outside (before) the code region.

2.10 WHEN a citation key appears inside an inline code span or fenced code block, THEN the language server SHALL NOT provide completion suggestions, diagnostics, or reference results for it; `@` inside code SHALL be treated as a literal character.

2.11 WHEN the markdown preview is rendered and CriticMarkup syntax appears inside a code region, THEN the preview plugin SHALL display the CriticMarkup as literal text, not as rendered markup.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN CriticMarkup syntax appears outside any code region, THEN the system SHALL CONTINUE TO apply editor decorations, navigation, and preview rendering as before.

3.2 WHEN format highlight syntax (`==text==`, `==text=={color}`) appears outside any code region, THEN the system SHALL CONTINUE TO apply highlight decorations as before.

3.3 WHEN CriticMarkup syntax surrounds a code span (e.g., `{==` `` `code` `` `==}{>>comment<<}`), THEN the system SHALL CONTINUE TO treat the CriticMarkup as live markup (the code span is the content, the CriticMarkup delimiters are outside it).

3.4 WHEN a Markdown file is exported to DOCX and CriticMarkup appears outside code regions, THEN the MD→DOCX converter SHALL CONTINUE TO interpret CriticMarkup as track changes, comments, and highlights.

3.5 WHEN a DOCX document is converted to Markdown and comments/formatting exist outside code regions, THEN the DOCX→MD converter SHALL CONTINUE TO emit CriticMarkup and formatting syntax as before.

3.6 WHEN a citation key appears outside any code region, THEN the language server SHALL CONTINUE TO provide completions, diagnostics, and references as before.

3.7 WHEN fenced code blocks or inline code spans contain no CriticMarkup or Manuscript Markdown syntax, THEN the system SHALL CONTINUE TO render them as code with no behavioral change.

3.8 WHEN the TextMate grammar tokenizes code regions, THEN it SHALL CONTINUE TO exclude CriticMarkup scopes from inline code and fenced code blocks (the existing `injectionSelector` already handles this correctly).
