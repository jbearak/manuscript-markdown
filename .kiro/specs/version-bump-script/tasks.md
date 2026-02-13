# Implementation Plan: Version Bump Script

## Overview

This implementation plan creates a bash shell script that automates semantic version bumping for the mdmarkup VS Code extension. The script follows the pattern established in the raven repository, using standard Unix tools and npm for reliable package.json updates.

## Tasks

- [x] 1. Create script file with basic structure
  - Create `scripts/bump-version.sh` with executable permissions
  - Add shebang line `#!/bin/bash`
  - Add `set -e` for fail-fast behavior
  - Set up SCRIPT_DIR and REPO_ROOT variables
  - Add usage function with help text
  - _Requirements: 1.5_

- [ ] 2. Implement input validation and version calculation
  - [x] 2.1 Parse command-line arguments with default to "patch"
    - Handle `--help` and `-h` flags to show usage
    - Default to "patch" if no argument provided
    - Store bump type in BUMP variable
    - _Requirements: 1.1_
  
  - [x] 2.2 Read current version from package.json
    - Use grep and sed to extract version field
    - Store in CURRENT_VERSION variable
    - Exit with error if version cannot be read
    - _Requirements: 1.2_
  
  - [ ] 2.3 Calculate new version based on bump type
    - For "major", "minor", "patch": parse version and increment appropriate component
    - For explicit version string: use as-is
    - Strip pre-release suffix before parsing for bump types
    - Store result in VERSION variable
    - _Requirements: 1.2_
  
  - [ ] 2.4 Validate version format
    - Check VERSION matches regex: `^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`
    - Exit with error message if invalid format
    - _Requirements: 1.1, 1.2_

- [ ] 2.5 Write property test for version calculation
  - **Property 2: Version Calculation Correctness**
  - **Validates: Requirements 1.2**

- [ ] 2.6 Write property test for input validation
  - **Property 1: Input Validation**
  - **Validates: Requirements 1.1**

- [ ] 3. Implement precondition checks
  - [ ] 3.1 Check git working directory is clean
    - Use `git status --porcelain` to check for uncommitted changes
    - Exit with error message and show status if dirty
    - _Requirements: 1.4_
  
  - [ ] 3.2 Check target tag doesn't already exist
    - Use `git rev-parse` to check for existing tag
    - Exit with error if tag `v$VERSION` already exists
    - _Requirements: 1.4_

- [ ] 3.3 Write unit tests for precondition checks
  - Test dirty working directory rejection
  - Test existing tag rejection
  - _Requirements: 1.4_

- [ ] 4. Implement file update using npm
  - [ ] 4.1 Update package.json with npm version command
    - Run `npm version "$VERSION" --no-git-tag-version --allow-same-version`
    - Suppress npm output with `>/dev/null`
    - This updates both package.json and package-lock.json if present
    - _Requirements: 1.2_

- [ ] 4.2 Write property test for file update preservation
  - **Property 4: File Update Preservation**
  - **Validates: Requirements 1.2**

- [ ] 4.3 Write property test for version extraction
  - **Property 3: Version Extraction**
  - **Validates: Requirements 1.2**

- [ ] 5. Implement git operations
  - [ ] 5.1 Stage modified files
    - Stage package.json
    - Stage package-lock.json if it exists
    - _Requirements: 1.3_
  
  - [ ] 5.2 Create git commit
    - Commit with message: `chore: bump version to $VERSION`
    - _Requirements: 1.3_
  
  - [ ] 5.3 Create git tag
    - Create lightweight tag: `v$VERSION`
    - Do NOT push automatically
    - _Requirements: 1.3_
  
  - [ ] 5.4 Display success message
    - Show version and tag information
    - Remind user to push manually
    - _Requirements: 1.3_

- [ ] 5.5 Write property tests for git operations
  - **Property 5: Commit Message Format**
  - **Property 6: Tag Format**
  - **Validates: Requirements 1.3**

- [ ] 5.6 Write unit test for no automatic push
  - Verify script does not perform git push
  - _Requirements: 1.3_

- [ ] 6. Checkpoint - Manual testing
  - Test script with various bump types (major, minor, patch)
  - Test with explicit version strings
  - Test error cases (dirty directory, existing tag, invalid input)
  - Verify package.json and package-lock.json are updated correctly
  - Verify git commit and tag are created correctly
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The script uses `set -e` so any command failure will exit immediately
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The script follows the pattern from the raven repository for consistency
