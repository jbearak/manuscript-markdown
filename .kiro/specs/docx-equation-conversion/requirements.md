# Requirements Document

## Introduction

This feature adds equation/math support to the existing DOCX-to-Markdown converter. DOCX files store equations using OMML (Office Math Markup Language) within `m:oMath` and `m:oMathPara` elements. The converter shall translate these into LaTeX notation embedded in Markdown using `$...$` for inline equations and `$$...$$` for display (block) equations.

## Glossary

- **Converter**: The DOCX-to-Markdown conversion module in `src/converter.ts`
- **OMML**: Office Math Markup Language, the XML-based equation format used in DOCX files
- **WordprocessingML (`w:*`)**: The XML namespace for general DOCX document structure
- **OMML (`m:*`)**: The XML namespace for math structures in DOCX
- **Inline_Equation**: An equation appearing within a paragraph of text, rendered using `$...$` delimiters
- **Display_Equation**: A standalone equation on its own line, rendered using `$$...$$` delimiters
- **LaTeX_Notation**: The mathematical typesetting syntax used to represent equations in Markdown
- **OMML_Element**: An XML element in the DOCX document representing a math construct (e.g., fractions, superscripts, radicals)

## Requirements

### Requirement 1: Inline Equation Conversion

**User Story:** As a user converting a DOCX file, I want inline equations to appear as `$...$` LaTeX in the Markdown output, so that math expressions remain readable and renderable within paragraph text.

#### Acceptance Criteria

1. WHEN the Converter encounters an `m:oMath` element inside a paragraph, THE Converter SHALL emit the equation as an Inline_Equation wrapped in `$...$` delimiters
2. WHEN an Inline_Equation appears adjacent to text, THE Converter SHALL preserve surrounding text and spacing so the equation integrates naturally into the sentence
3. WHEN an Inline_Equation contains only a plain text variable or number, THE Converter SHALL still wrap the content in `$...$` delimiters
4. WHEN emitting Inline_Equation output, THE Converter SHALL NOT add or remove whitespace inside `$...$` delimiters unless required to produce syntactically valid LaTeX

### Requirement 2: Display Equation Conversion

**User Story:** As a user converting a DOCX file, I want display (block) equations to appear as `$$...$$` LaTeX in the Markdown output, so that standalone equations are rendered prominently on their own line.

#### Acceptance Criteria

1. WHEN the Converter encounters an `m:oMathPara` element, THE Converter SHALL emit the equation as a Display_Equation wrapped in `$$...$$` delimiters on its own line
2. WHEN a Display_Equation is emitted, THE Converter SHALL separate the `$$...$$` block from surrounding content with blank lines
3. WHEN the translated LaTeX has no line breaks, THE Converter MAY emit single-line display form `$$...$$`
4. WHEN the translated LaTeX has line breaks (or represents aligned/multi-row math), THE Converter SHALL emit multi-line display form using opening `$$` and closing `$$` on separate lines
5. WHEN producing display math, THE Converter SHALL preserve mathematical semantics regardless of whether single-line or multi-line `$$` form is chosen

### Requirement 3: OMML-to-LaTeX Translation

**User Story:** As a user converting a DOCX file, I want OMML math constructs translated into correct LaTeX notation, so that the equations render accurately.

#### Acceptance Criteria

1. WHEN the Converter encounters an `m:f` (fraction) element, THE Converter SHALL emit `\frac{numerator}{denominator}` in LaTeX_Notation
2. WHEN the Converter encounters an `m:sSup` (superscript) element, THE Converter SHALL emit `base^{exponent}` in LaTeX_Notation
3. WHEN the Converter encounters an `m:sSub` (subscript) element, THE Converter SHALL emit `base_{subscript}` in LaTeX_Notation
4. WHEN the Converter encounters an `m:sSubSup` (sub-superscript) element, THE Converter SHALL emit `base_{subscript}^{superscript}` in LaTeX_Notation
5. WHEN the Converter encounters an `m:rad` (radical) element with no explicit degree, THE Converter SHALL emit `\sqrt{radicand}` in LaTeX_Notation
6. WHEN the Converter encounters an `m:rad` (radical) element with an explicit degree, THE Converter SHALL emit `\sqrt[degree]{radicand}` in LaTeX_Notation
7. WHEN the Converter encounters an `m:nary` (n-ary operator) element, THE Converter SHALL emit the appropriate operator (e.g., `\sum`, `\prod`, `\int`) with subscript and superscript limits in LaTeX_Notation
8. WHEN the Converter encounters an `m:d` (delimiter/parentheses) element, THE Converter SHALL emit the content wrapped in the specified opening and closing delimiters in LaTeX_Notation
9. WHEN the Converter encounters an `m:acc` (accent) element, THE Converter SHALL emit the corresponding LaTeX accent command (e.g., `\hat`, `\bar`, `\dot`) in LaTeX_Notation
10. WHEN the Converter encounters an `m:m` (matrix) element, THE Converter SHALL emit a LaTeX matrix environment with rows separated by `\\` and columns separated by `&`
11. WHEN the Converter encounters an `m:func` (function) element, THE Converter SHALL emit the function name followed by its argument in LaTeX_Notation
12. WHEN the Converter encounters an `m:r` (math run) element containing text, THE Converter SHALL emit the text content, applying italic formatting for single-letter variables by default
13. WHEN the Converter encounters nested OMML_Elements, THE Converter SHALL recursively translate each element and compose the LaTeX output correctly

### Requirement 3A: Unsupported and Out-of-Scope OMML Constructs

**User Story:** As a developer, I want unsupported OMML constructs to be explicitly scoped and handled deterministically, so that behavior is predictable during incremental rollout.

#### Acceptance Criteria

1. THE Converter SHALL support at minimum the OMML constructs listed in Requirement 3 for initial release
2. WHEN the Converter encounters valid but unsupported OMML constructs outside the initial supported set, THE Converter SHALL apply Requirement 6 fallback behavior
3. THE project documentation SHALL list the supported OMML subset and examples of unsupported constructs

### Requirement 4: Special Characters and Symbols

**User Story:** As a user converting a DOCX file, I want Greek letters, operators, and special math symbols to appear as their LaTeX equivalents, so that the full range of mathematical notation is preserved.

#### Acceptance Criteria

1. WHEN the Converter encounters a Unicode Greek letter in an OMML_Element, THE Converter SHALL emit the corresponding LaTeX command (e.g., `α` becomes `\alpha`, `Ψ` becomes `\Psi`)
2. WHEN the Converter encounters a Unicode math operator or symbol in an OMML_Element, THE Converter SHALL emit the corresponding LaTeX command (e.g., `×` becomes `\times`, `≤` becomes `\leq`)
3. WHEN the Converter encounters a character that has no specific LaTeX command equivalent, THE Converter SHALL emit the character directly in the LaTeX output

### Requirement 4A: LaTeX Escaping and Markdown Safety

**User Story:** As a user converting DOCX files, I want generated math to be syntactically valid and safe in Markdown, so that output renders reliably.

#### Acceptance Criteria

1. WHEN emitting LaTeX_Notation, THE Converter SHALL escape or encode characters that would otherwise break LaTeX syntax where appropriate
2. WHEN fallback plain text is emitted into LaTeX context, THE Converter SHALL escape reserved LaTeX characters as needed to keep output syntactically valid
3. WHEN emitting Inline_Equation and Display_Equation delimiters, THE Converter SHALL avoid producing ambiguous or unmatched delimiter sequences in surrounding Markdown content

### Requirement 5: OMML-to-LaTeX Round Trip Fidelity

**User Story:** As a developer, I want confidence that the OMML-to-LaTeX translation is structurally faithful, so that the converter produces correct output for arbitrary equations.

#### Acceptance Criteria

1. FOR generated OMML trees within the supported subset and bounded depth/size, converting to LaTeX and re-parsing the LaTeX SHALL produce a structurally equivalent mathematical expression
2. WHEN the Converter translates an OMML tree to LaTeX, THE Converter SHALL produce syntactically valid LaTeX that contains balanced braces and correct command usage
3. THE Converter test suite SHALL include property-based or fuzz-style tests over bounded supported OMML inputs to validate structural fidelity invariants

### Requirement 6: Error Handling

**User Story:** As a user converting a DOCX file, I want the converter to handle malformed or unsupported equation markup gracefully, so that conversion does not fail entirely.

#### Acceptance Criteria

1. IF the Converter encounters an unrecognized OMML_Element, THEN THE Converter SHALL emit the plain text content of that element as a fallback
2. IF the Converter encounters an OMML_Element with missing required children, THEN THE Converter SHALL emit an empty placeholder and continue conversion
3. IF the Converter encounters an empty `m:oMath` or `m:oMathPara` element, THEN THE Converter SHALL skip the element without emitting delimiters
4. IF fallback behavior is used for an OMML_Element, THEN THE Converter SHALL continue converting subsequent content without throwing a fatal error
