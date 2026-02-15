# Requirements Document

## Introduction

Standalone command-line tools for converting between Markdown and DOCX formats, reusing the existing Manuscript Markdown conversion logic without requiring the VS Code extension. The tools provide the same conversion fidelity as the extension commands but are invocable from any terminal environment.

## Glossary

- **CLI**: Command-line interface; a text-based interface for invoking the tools
- **DOCX_to_MD_Tool**: The CLI entry point that converts DOCX files to Manuscript Markdown format
- **MD_to_DOCX_Tool**: The CLI entry point that converts Manuscript Markdown files to DOCX format
- **Converter_Library**: The existing `converter.ts` and `md-to-docx.ts` modules that perform the actual conversion
- **Citation_Key_Format**: One of `authorYearTitle`, `authorYear`, or `numeric`; controls how Zotero citation keys are generated during DOCX-to-MD conversion
- **Mixed_Citation_Style**: One of `separate` or `unified`; controls how mixed Zotero/non-Zotero grouped citations are rendered during MD-to-DOCX conversion
- **CSL_Cache_Directory**: A local directory where downloaded CSL styles are cached for reuse
- **Template_DOCX**: An optional DOCX file whose styles, theme, and numbering definitions are applied to the exported DOCX
- **Output_Conflict**: A situation where the target output file already exists on disk
- **Setup_Script**: The `setup.sh` shell script that builds and installs project artifacts
- **CLI_Binary**: The compiled standalone `manuscript-markdown` executable installed to `~/bin`

## Requirements

### Requirement 1: DOCX to Markdown Conversion

**User Story:** As a user, I want to convert a DOCX file to Manuscript Markdown from the command line, so that I can use the converter without opening VS Code.

#### Acceptance Criteria

1. WHEN the DOCX_to_MD_Tool is invoked with a path to a valid DOCX file, THE DOCX_to_MD_Tool SHALL produce a Markdown file and, if citations are present, a BibTeX file in the same directory as the input
2. WHEN the DOCX_to_MD_Tool is invoked with the `--citation-key-format` flag, THE DOCX_to_MD_Tool SHALL pass the specified Citation_Key_Format to the Converter_Library
3. WHEN the `--citation-key-format` flag is omitted, THE DOCX_to_MD_Tool SHALL default to `authorYearTitle`
4. WHEN the DOCX_to_MD_Tool is invoked with the `--output` flag, THE DOCX_to_MD_Tool SHALL write output files using the specified base path instead of deriving it from the input filename
5. WHEN the input file does not exist or is not a valid DOCX file, THE DOCX_to_MD_Tool SHALL exit with a non-zero exit code and print a descriptive error message to stderr

### Requirement 2: Markdown to DOCX Conversion

**User Story:** As a user, I want to convert a Manuscript Markdown file to DOCX from the command line, so that I can produce Word documents without opening VS Code.

#### Acceptance Criteria

1. WHEN the MD_to_DOCX_Tool is invoked with a path to a Markdown file, THE MD_to_DOCX_Tool SHALL produce a DOCX file in the same directory as the input
2. WHEN a companion `.bib` file exists with the same base name as the input Markdown file, THE MD_to_DOCX_Tool SHALL automatically load it for citation resolution
3. WHEN the MD_to_DOCX_Tool is invoked with the `--bib` flag, THE MD_to_DOCX_Tool SHALL use the specified BibTeX file instead of auto-detecting one
4. WHEN the MD_to_DOCX_Tool is invoked with the `--template` flag, THE MD_to_DOCX_Tool SHALL extract styling from the specified Template_DOCX and apply it to the output
5. WHEN the MD_to_DOCX_Tool is invoked with the `--author` flag, THE MD_to_DOCX_Tool SHALL use the specified author name in the document properties
6. WHEN the `--author` flag is omitted, THE MD_to_DOCX_Tool SHALL fall back to the OS username
7. WHEN the MD_to_DOCX_Tool is invoked with the `--output` flag, THE MD_to_DOCX_Tool SHALL write the DOCX to the specified path instead of deriving it from the input filename
8. WHEN the MD_to_DOCX_Tool is invoked with the `--mixed-citation-style` flag, THE MD_to_DOCX_Tool SHALL pass the specified Mixed_Citation_Style to the Converter_Library
9. WHEN the `--mixed-citation-style` flag is omitted, THE MD_to_DOCX_Tool SHALL default to `separate`
10. WHEN the input file does not exist or is not readable, THE MD_to_DOCX_Tool SHALL exit with a non-zero exit code and print a descriptive error message to stderr

### Requirement 3: Output Conflict Handling

**User Story:** As a user, I want the CLI tools to handle existing output files safely, so that I do not accidentally overwrite my work.

#### Acceptance Criteria

1. WHEN the target output file already exists and the `--force` flag is not provided, THE CLI tool SHALL exit with a non-zero exit code and print a message indicating the conflict
2. WHEN the target output file already exists and the `--force` flag is provided, THE CLI tool SHALL overwrite the existing file without prompting
3. WHEN the DOCX_to_MD_Tool detects that both `.md` and `.bib` output files already exist, THE DOCX_to_MD_Tool SHALL report both conflicts in the error message

### Requirement 4: CSL Style Handling in CLI

**User Story:** As a user, I want the MD-to-DOCX CLI tool to handle CSL styles for citation formatting, so that my bibliography is formatted correctly.

#### Acceptance Criteria

1. WHEN the Markdown frontmatter specifies a `csl` field and the style is bundled, THE MD_to_DOCX_Tool SHALL use the bundled style for citation formatting
2. WHEN the Markdown frontmatter specifies a `csl` field and the style is not bundled, THE MD_to_DOCX_Tool SHALL attempt to download the style from the CSL repository
3. WHEN the MD_to_DOCX_Tool is invoked with the `--csl-cache-dir` flag, THE MD_to_DOCX_Tool SHALL use the specified directory for caching downloaded CSL styles
4. WHEN the `--csl-cache-dir` flag is omitted, THE MD_to_DOCX_Tool SHALL use a default cache directory in the user's home directory
5. IF a CSL style download fails, THEN THE MD_to_DOCX_Tool SHALL print a warning to stderr and continue the export without CSL citation formatting

### Requirement 5: CLI Interface and Usability

**User Story:** As a user, I want the CLI tools to follow standard CLI conventions, so that they are intuitive and easy to use.

#### Acceptance Criteria

1. THE CLI SHALL be invocable as `manuscript-markdown <input>` where the conversion direction is determined by the input file extension (`.docx` → Markdown, `.md` → DOCX)
2. WHEN the input file extension is not `.docx` or `.md`, THE CLI SHALL exit with a non-zero exit code and print a descriptive error message to stderr
3. WHEN invoked with `--help`, THE CLI tool SHALL print usage information including all available flags and their descriptions
4. WHEN invoked with `--version`, THE CLI tool SHALL print the version number from package.json
5. WHEN the conversion completes successfully, THE CLI tool SHALL print the path of each output file to stdout
6. WHEN warnings are generated during conversion, THE CLI tool SHALL print warnings to stderr and still exit with code 0

### Requirement 6: Build and Install via setup.sh

**User Story:** As a user, I want `setup.sh` to build the CLI tool and install it to `~/bin`, so that I can run `manuscript-markdown` from any terminal after setup.

#### Acceptance Criteria

1. WHEN `setup.sh` is run, IT SHALL compile the CLI entry point into a standalone executable (or runnable script) in addition to the existing VSIX build
2. WHEN `setup.sh` completes the CLI build, IT SHALL copy the built CLI artifact to `~/bin/manuscript-markdown`
3. WHEN `~/bin` does not exist, `setup.sh` SHALL create it
4. WHEN the CLI is installed to `~/bin`, IT SHALL be executable (i.e., have appropriate permissions set)
5. WHEN the installation succeeds, `setup.sh` SHALL print the installed path and a reminder to ensure `~/bin` is on the user's `PATH`

### Requirement 7: Documentation

**User Story:** As a user, I want the CLI tools to be documented, so that I can learn how to install and use them.

#### Acceptance Criteria

1. THE project SHALL include a dedicated CLI documentation file in the `docs/` directory (e.g., `docs/cli.md`) containing full installation instructions, usage examples for both conversion directions, and descriptions of all available flags and their default values
2. THE `README.md` SHALL include a brief section mentioning the CLI tool with a link to the dedicated CLI documentation file, without duplicating detailed usage information
3. THE dedicated CLI documentation SHALL include instructions for running the CLI via `setup.sh` (install to `~/bin`), via `bun`, and via `npx`

### Requirement 8: Setup Script Builds and Installs CLI Tool

**User Story:** As a developer, I want `setup.sh` to build the standalone CLI tool and install it to `~/bin`, so that the CLI is available on my PATH after running the same setup script I use for the extension.

#### Acceptance Criteria

1. WHEN the Setup_Script is executed, THE Setup_Script SHALL compile the CLI entry point into a standalone executable using `bun build` with the `--compile` flag
2. WHEN the CLI compilation succeeds, THE Setup_Script SHALL copy the resulting CLI_Binary to `~/bin/manuscript-markdown`
3. WHEN the `~/bin` directory does not exist, THE Setup_Script SHALL create it before copying the CLI_Binary
4. WHEN the CLI_Binary is placed in `~/bin`, THE Setup_Script SHALL ensure the file has executable permissions
5. IF the CLI compilation fails, THEN THE Setup_Script SHALL print a descriptive error message to stderr and continue with the remaining setup steps
6. WHEN the Setup_Script completes, THE Setup_Script SHALL print the installed CLI_Binary path alongside the existing extension installation summary
