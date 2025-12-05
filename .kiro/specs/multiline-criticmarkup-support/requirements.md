# Requirements Document

## Introduction

This feature enables CriticMarkup syntax to span multiple lines in Markdown documents. Currently, the TextMate grammar and parsing logic may not properly handle CriticMarkup patterns that contain newline characters, limiting users to single-line edits. This enhancement will allow users to mark up longer passages of text that naturally span multiple lines, making CriticMarkup more practical for real-world editing workflows.

## Glossary

- **CriticMarkup**: A lightweight markup syntax for tracking changes in plain text documents, consisting of five patterns: additions, deletions, substitutions, comments, and highlights
- **TextMate Grammar**: A declarative syntax definition used by VS Code to provide syntax highlighting through pattern matching
- **Inline Rule**: A markdown-it parsing rule that processes inline content (as opposed to block-level content)
- **Pattern**: A specific CriticMarkup syntax type (addition `{++...++}`, deletion `{--...--}`, substitution `{~~...~>...~~}`, comment `{>>...<<}`, or highlight `{==...==}`)
- **Extension**: The VS Code CriticMarkup extension that provides syntax highlighting, snippets, and navigation commands

## Requirements

### Requirement 1

**User Story:** As a writer, I want to mark additions that span multiple lines, so that I can track substantial new content in my documents.

#### Acceptance Criteria

1. WHEN a user types `{++` followed by text containing newlines and then `++}` THEN the Extension SHALL recognize this as a valid addition pattern
2. WHEN an addition pattern spans multiple lines THEN the Extension SHALL apply syntax highlighting to all lines within the pattern
3. WHEN navigating with next/previous change commands THEN the Extension SHALL correctly identify and select multi-line addition patterns
4. WHEN rendering in preview THEN the Extension SHALL display multi-line additions with appropriate styling across all lines

### Requirement 2

**User Story:** As an editor, I want to mark deletions that span multiple lines, so that I can indicate removal of entire paragraphs or sections.

#### Acceptance Criteria

1. WHEN a user types `{--` followed by text containing newlines and then `--}` THEN the Extension SHALL recognize this as a valid deletion pattern
2. WHEN a deletion pattern spans multiple lines THEN the Extension SHALL apply syntax highlighting to all lines within the pattern
3. WHEN navigating with next/previous change commands THEN the Extension SHALL correctly identify and select multi-line deletion patterns
4. WHEN rendering in preview THEN the Extension SHALL display multi-line deletions with appropriate styling across all lines

### Requirement 3

**User Story:** As a reviewer, I want to mark substitutions where both old and new text span multiple lines, so that I can suggest comprehensive rewrites of content.

#### Acceptance Criteria

1. WHEN a user types `{~~` followed by text containing newlines, then `~>`, then text containing newlines, and then `~~}` THEN the Extension SHALL recognize this as a valid substitution pattern
2. WHEN a substitution pattern spans multiple lines THEN the Extension SHALL apply syntax highlighting to all lines within the pattern
3. WHEN navigating with next/previous change commands THEN the Extension SHALL correctly identify and select multi-line substitution patterns
4. WHEN rendering in preview THEN the Extension SHALL display multi-line substitutions with appropriate styling for both old and new text across all lines

### Requirement 4

**User Story:** As a collaborator, I want to add comments that span multiple lines, so that I can provide detailed feedback and explanations.

#### Acceptance Criteria

1. WHEN a user types `{>>` followed by text containing newlines and then `<<}` THEN the Extension SHALL recognize this as a valid comment pattern
2. WHEN a comment pattern spans multiple lines THEN the Extension SHALL apply syntax highlighting to all lines within the pattern
3. WHEN navigating with next/previous change commands THEN the Extension SHALL correctly identify and select multi-line comment patterns
4. WHEN rendering in preview THEN the Extension SHALL display multi-line comments with appropriate styling across all lines

### Requirement 5

**User Story:** As a content manager, I want to highlight passages that span multiple lines, so that I can draw attention to important sections that need review.

#### Acceptance Criteria

1. WHEN a user types `{==` followed by text containing newlines and then `==}` THEN the Extension SHALL recognize this as a valid highlight pattern
2. WHEN a highlight pattern spans multiple lines THEN the Extension SHALL apply syntax highlighting to all lines within the pattern
3. WHEN navigating with next/previous change commands THEN the Extension SHALL correctly identify and select multi-line highlight patterns
4. WHEN rendering in preview THEN the Extension SHALL display multi-line highlights with appropriate styling across all lines

### Requirement 6

**User Story:** As a writer, I want CriticMarkup patterns to work correctly even when they contain empty lines, so that I can mark up natural paragraph breaks within my changes.

#### Acceptance Criteria

1. WHEN a CriticMarkup pattern contains one or more empty lines THEN the Extension SHALL recognize the entire pattern including the empty lines
2. WHEN rendering a pattern with empty lines in preview THEN the Extension SHALL preserve the empty lines in the output HTML
3. WHEN navigating to a pattern with empty lines THEN the Extension SHALL select the entire pattern including all empty lines
4. WHEN syntax highlighting a pattern with empty lines THEN the Extension SHALL apply highlighting to all lines including the lines before and after empty lines

### Requirement 7

**User Story:** As a developer, I want the multi-line parsing to be efficient, so that the extension remains responsive even with large documents containing many multi-line patterns.

#### Acceptance Criteria

1. WHEN parsing a document with multi-line CriticMarkup patterns THEN the Extension SHALL complete syntax highlighting within 100 milliseconds for documents up to 10,000 lines
2. WHEN navigating between changes in a document with multi-line patterns THEN the Extension SHALL respond to navigation commands within 50 milliseconds
3. WHEN rendering preview for documents with multi-line patterns THEN the Extension SHALL generate HTML output within 200 milliseconds for documents up to 10,000 lines
