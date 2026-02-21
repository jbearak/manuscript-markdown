# Bugfix Requirements Document

## Introduction

HTML comments (`<!-- ... -->`) in Markdown are lost during the MD → DOCX → MD roundtrip. The md-to-docx converter currently drops HTML comments silently — `processInlineChildren()` only handles `<u>`, `<sup>`, `<sub>` formatting tags in `html_inline` tokens, and `convertTokens()` only handles HTML tables in `html_block` tokens. Any `<!-- ... -->` content is discarded during export and cannot be recovered on re-import.

The fix must encode HTML comments as invisible (hidden) elements in the Word document — mirroring the approach used for LaTeX `%` comments inside equations, but operating at the document level (as `w:r` runs with vanish styling) rather than inside OMML math elements. On re-import from DOCX to markdown, the converter must detect these hidden runs and restore the original `<!-- ... -->` delimiters.

HTML comment delimiters must NOT be processed (interpreted) inside inert zones: LaTeX math regions (`$...$`, `$$...$$`), code regions (`` ` ``, ``` `` ```, ```` ``` ````, ````` ```` `````), or CriticMarkup regions (e.g., `{>> ... <<}`). Inside those regions, `<!-- -->` is plain text and must pass through unchanged.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Markdown paragraph contains an HTML comment (e.g., `text <!-- hidden note --> more text`) THEN the system silently drops the `<!-- hidden note -->` during MD → DOCX conversion, producing a Word document with no trace of the comment

1.2 WHEN a Markdown document contains a standalone HTML comment on its own line (e.g., `<!-- TODO: revise this section -->`) THEN the system silently drops the entire comment during MD → DOCX conversion

1.3 WHEN a DOCX file that was exported from Markdown containing HTML comments is re-imported to Markdown THEN the system produces output with the HTML comments missing, breaking the roundtrip

1.4 WHEN a Markdown paragraph contains multiple HTML comments (e.g., `A <!-- c1 --> B <!-- c2 --> C`) THEN the system drops all of them during MD → DOCX conversion

1.5 WHEN an HTML comment contains multi-line content (e.g., `<!-- line1\nline2 -->`) THEN the system drops the entire comment during MD → DOCX conversion

### Expected Behavior (Correct)

2.1 WHEN a Markdown paragraph contains an inline HTML comment (e.g., `text <!-- hidden note --> more text`) THEN the system SHALL encode the comment as an invisible (hidden/vanish) run in the DOCX output, preserving the comment content including its delimiters, so that the comment is not visible in Word but is retained in the document XML

2.2 WHEN a Markdown document contains a standalone HTML comment on its own line THEN the system SHALL encode it as an invisible run in the DOCX output, preserving the comment for roundtrip

2.3 WHEN a DOCX file containing invisible HTML comment runs is re-imported to Markdown THEN the system SHALL detect the hidden runs, extract the comment content, and restore the original `<!-- ... -->` syntax at the correct position in the output

2.4 WHEN a Markdown paragraph contains multiple HTML comments THEN the system SHALL encode each one as a separate invisible run in the DOCX, and restore all of them on re-import

2.5 WHEN an HTML comment contains multi-line content THEN the system SHALL preserve the full content (including internal newlines) through the roundtrip

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a Markdown document contains no HTML comments THEN the system SHALL CONTINUE TO convert to DOCX and re-import identically to current behavior

3.2 WHEN a Markdown document contains HTML formatting tags (`<u>`, `<sup>`, `<sub>`) THEN the system SHALL CONTINUE TO apply the corresponding formatting in the DOCX output as it does today

3.3 WHEN a Markdown document contains HTML tables THEN the system SHALL CONTINUE TO convert them to Word tables as it does today

3.4 WHEN a Markdown document contains LaTeX equations with `%` line comments THEN the system SHALL CONTINUE TO handle them via the existing OMML hidden-run mechanism (the document-level HTML comment encoding must not interfere with equation-level LaTeX comment encoding)

3.5 WHEN a Markdown document contains CriticMarkup (additions, deletions, substitutions, highlights, comments) that does not contain `<!-- -->` THEN the system SHALL CONTINUE TO convert them to tracked changes and Word comments as it does today

3.6 WHEN a Markdown document contains code blocks or inline code that does not contain `<!-- -->` THEN the system SHALL CONTINUE TO convert them to code-styled content in the DOCX as it does today

3.7 WHEN a user edits visible text in Word that is adjacent to a hidden HTML comment run THEN the hidden run SHALL CONTINUE TO be present in the DOCX XML and SHALL be restored on re-import

3.8 WHEN an HTML comment appears inside a LaTeX math region (`$...$` or `$$...$$`) THEN the system SHALL NOT treat `<!-- -->` as an HTML comment — it SHALL pass through as literal text within the equation

3.9 WHEN an HTML comment appears inside a code region (inline code spans or fenced code blocks) THEN the system SHALL NOT treat `<!-- -->` as an HTML comment — it SHALL pass through as literal code content

3.10 WHEN an HTML comment appears inside a CriticMarkup region (e.g., `{>> <!-- note --> <<}`, `{++ <!-- added --> ++}`, `{-- <!-- deleted --> --}`, `{== <!-- highlighted --> ==}`, `{~~ <!-- old --> ~> <!-- new --> ~~}`) THEN the system SHALL NOT treat `<!-- -->` as an HTML comment — it SHALL pass through as plain text within the CriticMarkup content
