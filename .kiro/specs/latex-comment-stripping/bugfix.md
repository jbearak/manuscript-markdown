# Bugfix Requirements Document

## Introduction

In LaTeX, the `%` character begins a line comment — everything from `%` to the end of the line is ignored by the LaTeX engine. The md-to-docx converter currently passes `%` comments through as literal text in the OMML output, causing comment content to appear as visible text in the exported Word document. This is because the `tokenize()` function in `src/latex-to-omml.ts` has no handling for `%` and treats it (and everything after it on the line) as regular text tokens.

The fix must strip comments from the visible OMML output and embed them as non-visible elements inline within the OMML XML itself. This ensures comments are invisible in Word but remain anchored to their position in the equation. Because the comments live inside the OMML structure (rather than in a separate stash of the original LaTeX source), they survive user edits to other parts of the equation. On re-import from DOCX to markdown, the `ommlToLatex()` function extracts these hidden elements and restores them as LaTeX `%` comments.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a LaTeX equation contains a `%` line comment (e.g., `x^2 % superscript`) THEN the system includes the `%` character and all text after it up to the end of the line as literal text in the OMML output, making the comment visible in Word

1.2 WHEN a multi-line LaTeX equation (e.g., inside `align*`) contains `%` comments on one or more lines THEN the system renders the comment text as visible content in the exported Word document

1.3 WHEN a LaTeX equation contains a `%` at the end of a line used purely as a line-continuation marker (e.g., to suppress the newline whitespace) THEN the system includes the `%` as literal text in the output

### Expected Behavior (Correct)

2.1 WHEN a LaTeX equation contains a `%` line comment (e.g., `x^2 % superscript`) THEN the system SHALL strip the `%` and all text after it from the visible OMML output, AND SHALL embed the comment text as a non-visible inline element within the OMML at the position where the comment occurred, so that the comment is invisible in Word but preserved in the XML. The non-visible inline marker SHALL store not only the comment text but also the whitespace (spaces and tabs) that appears between the equation content and the `%` character.

2.2 WHEN a multi-line LaTeX equation contains `%` comments on one or more lines (e.g., vertically aligned comments like `x^2          % superscript` / `x_i          % subscript`) THEN the system SHALL strip all comment text from the visible OMML conversion so no comment content appears in the exported Word document, AND SHALL embed each comment as a non-visible inline element at its respective position within the OMML structure, with each marker storing the preceding whitespace (spaces/tabs) between the equation content and the `%` character

2.3 WHEN a LaTeX equation contains a `%` at the end of a line used as a line-continuation marker THEN the system SHALL strip the `%` and the newline from the visible OMML (joining the lines without extra whitespace), AND SHALL embed a non-visible inline marker at that position so the line-continuation `%` is restored on roundtrip. The preceding whitespace (spaces/tabs between equation content and the `%`) SHALL be stored in the non-visible marker and restored on roundtrip.

2.4 WHEN a DOCX file containing OMML with embedded non-visible comment elements is re-imported to markdown THEN the system SHALL extract the hidden comment elements and restore them as LaTeX `%` comments at their original positions in the equation source, including restoring the original whitespace (spaces/tabs) before the `%` character so that vertically aligned comments remain aligned after roundtrip

2.5 WHEN the LaTeX equation reference documentation (`docs/latex-equations.md`) is consulted THEN it SHALL contain a section documenting `%` comments — explaining that `%` starts a line comment in LaTeX and everything after it to the end of the line is ignored by the LaTeX engine

2.6 WHEN the LaTeX equation reference documentation (`docs/latex-equations.md`) documents `%` comments THEN it SHALL also explain the roundtrip behavior: when LaTeX `%` comments are used inside display math, they are preserved (but invisible) in the exported Word `.docx`, and restored on re-import back to Markdown

2.7 WHEN the converter documentation (`docs/converter.md`) is consulted THEN it SHALL contain documentation explaining how LaTeX `%` comments are handled during export and import — specifically that comments are stripped from visible OMML output, embedded as non-visible elements within the OMML structure, and restored as LaTeX `%` comments on re-import from DOCX to markdown

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a LaTeX equation contains `\%` (escaped percent) THEN the system SHALL CONTINUE TO render a literal `%` symbol in the OMML output

3.2 WHEN a LaTeX equation contains no `%` characters THEN the system SHALL CONTINUE TO convert the equation to OMML identically to current behavior

3.3 WHEN a LaTeX equation contains only equation content before a `%` comment THEN the system SHALL CONTINUE TO correctly convert that equation content to OMML (the fix must not alter the non-comment portion of the equation)

3.4 WHEN a LaTeX equation without comments is roundtripped through MD → DOCX → MD THEN the system SHALL CONTINUE TO produce semantically equivalent LaTeX as it does today

3.5 WHEN a user edits parts of an OMML equation in Word that are unrelated to a hidden comment element THEN the hidden comment element SHALL CONTINUE TO be present in the OMML and SHALL be restored on re-import

3.6 WHEN a LaTeX equation with vertically aligned `%` comments (e.g., varying amounts of whitespace before `%` on each line) is roundtripped through MD → DOCX → MD THEN the system SHALL preserve the exact whitespace (spaces/tabs) preceding each `%` so that vertical alignment of comments is maintained
