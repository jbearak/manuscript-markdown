# Version Bump Script Requirements

## Overview
Create a shell script to automate version bumping for the mdmarkup VS Code extension, similar to the patterns used in other projects (raven/sight repos).

## User Stories

### 1. As a developer, I want to bump the version with a single command
So that I can quickly prepare releases without manually editing files.

### 2. As a developer, I want to support semantic versioning
So that I can bump major, minor, or patch versions appropriately.

### 3. As a developer, I want the script to update all relevant files
So that version numbers stay consistent across the project.

### 4. As a developer, I want the script to create a git commit and tag
So that releases are properly tracked in version control.

## Acceptance Criteria

### 1.1 Script accepts version bump type as argument
- Script accepts one of: `major`, `minor`, `patch`
- Shows usage help if no argument or invalid argument provided
- Exits with error code if invalid input

### 1.2 Script updates package.json version
- Reads current version from package.json
- Calculates new version based on bump type
- Updates version field in package.json

### 1.3 Script creates git commit and tag
- Commits the version change with message "Bump version to X.Y.Z"
- Creates annotated git tag "vX.Y.Z"
- Does not push automatically (user controls when to push)

### 1.4 Script validates preconditions
- Checks that git working directory is clean before bumping
- Exits with error if there are uncommitted changes
- Provides clear error messages

### 1.5 Script is executable and located in scripts directory
- Script is placed in `scripts/bump-version.sh`
- Script has executable permissions
- Script uses bash shebang for portability

## Technical Constraints

- Must work on macOS (user's current platform)
- Should use standard Unix tools (sed, git, etc.)
- Must preserve package.json formatting
- Should be idempotent (safe to run multiple times)

## Out of Scope

- Automatic changelog generation
- Automatic npm publishing
- Automatic git push
- Version validation beyond semantic versioning format
