# Requirements Document

## Introduction

The `manuscriptMarkdown.mixedCitationStyle` setting controlled how mixed Zotero/non-Zotero grouped citations were rendered — either as `"separate"` (each portion in its own parentheses) or `"unified"` (one set of parentheses). After the Zotero citation mismatch fix (PR #113), non-Zotero entries use string IDs and synthetic URIs, so Zotero gracefully falls back to embedded `itemData` on refresh. This means unified style always works correctly and the setting is unnecessary. Additionally, the setting was not functioning as documented — even when set to `"separate"`, the converter produced unified output. This spec covers the complete removal of the setting from the extension, CLI, converter API, tests, and documentation.

## Glossary

- **Extension**: The Manuscript Markdown VS Code extension
- **CLI**: The standalone command-line interface (`src/cli.ts`) for converting between Markdown and DOCX
- **Converter**: The core conversion module (`src/md-to-docx.ts`) that transforms Markdown to DOCX
- **MdToDocxOptions**: The TypeScript options interface consumed by the Converter's `convertMdToDocx` function
- **VS_Code_Settings**: The `contributes.configuration` section in `package.json` that defines user-facing settings
- **Mixed_Citation_Group**: A Pandoc-style grouped citation (e.g., `[@zoteroEntry; @plainEntry]`) containing both Zotero-linked and plain BibTeX entries

## Requirements

### Requirement 1: Remove VS Code Setting Definition

**User Story:** As a developer, I want the obsolete `mixedCitationStyle` setting removed from the extension manifest, so that users no longer see a non-functional configuration option.

#### Acceptance Criteria

1. THE Extension SHALL NOT declare `manuscriptMarkdown.mixedCitationStyle` in VS_Code_Settings
2. WHEN a user opens VS Code settings and searches for "mixedCitationStyle", THE Extension SHALL return no matching settings

### Requirement 2: Remove Setting from Converter API

**User Story:** As a developer, I want the `mixedCitationStyle` option removed from the converter's options interface, so that the API surface reflects the current behavior.

#### Acceptance Criteria

1. THE MdToDocxOptions interface SHALL NOT include a `mixedCitationStyle` property
2. THE Converter SHALL produce unified-style output for Mixed_Citation_Groups without any configuration parameter

### Requirement 3: Remove Setting from Extension Host Code

**User Story:** As a developer, I want the extension host code to stop reading the `mixedCitationStyle` setting, so that there are no dead code paths.

#### Acceptance Criteria

1. THE Extension SHALL NOT read `manuscriptMarkdown.mixedCitationStyle` from the VS Code configuration API
2. THE Extension SHALL NOT pass a `mixedCitationStyle` value to the Converter

### Requirement 4: Remove CLI Flag

**User Story:** As a CLI user, I want the `--mixed-citation-style` flag removed, so that the CLI reflects the current behavior.

#### Acceptance Criteria

1. THE CLI SHALL NOT accept a `--mixed-citation-style` flag
2. THE CLI options type SHALL NOT include a `mixedCitationStyle` property
3. WHEN a user passes `--mixed-citation-style` to the CLI, THE CLI SHALL treat the flag as an unknown argument
4. THE CLI help text SHALL NOT mention `--mixed-citation-style`

### Requirement 5: Update Tests

**User Story:** As a developer, I want tests updated to reflect the removal, so that the test suite remains accurate and passing.

#### Acceptance Criteria

1. THE CLI test suite SHALL NOT generate or assert on `--mixed-citation-style` arguments
2. THE Converter test suite SHALL NOT pass `mixedCitationStyle` in options
3. THE Converter test suite SHALL verify that Mixed_Citation_Groups produce a single unified field code without any style parameter

### Requirement 6: Update Documentation

**User Story:** As a user, I want the documentation to reflect that mixed citations always use unified style, so that I have accurate information.

#### Acceptance Criteria

1. THE configuration documentation (`docs/configuration.md`) SHALL NOT list `mixedCitationStyle` as a setting
2. THE Zotero roundtrip documentation (`docs/zotero-roundtrip.md`) SHALL NOT describe the `mixedCitationStyle` setting or its values
3. THE Zotero roundtrip documentation SHALL explain that mixed citation groups always produce unified output
4. THE converter documentation (`docs/converter.md`) SHALL NOT reference `mixedCitationStyle`

### Requirement 7: Clean Up Internal Comments

**User Story:** As a developer, I want stale code comments referencing `mixedCitationStyle` removed, so that the codebase stays accurate.

#### Acceptance Criteria

1. THE Converter source code SHALL NOT contain comments referencing `mixedCitationStyle` or configurable mixed citation style behavior
