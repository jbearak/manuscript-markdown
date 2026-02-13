# Version Bump Script Design

## Overview

This design describes a bash shell script that automates semantic version bumping for the mdmarkup VS Code extension, following the pattern established in the raven repository. The script will read the current version from `package.json`, calculate the new version based on the bump type (major, minor, patch, or explicit version), update the file using `npm version`, and create a git commit with a tag.

The script follows Unix conventions and uses standard tools available on macOS (sed, git, npm). It validates preconditions before making changes, provides clear error messages for failure cases, and uses `set -e` for fail-fast behavior.

## Architecture

The script follows a linear execution flow with validation gates:

```
Input Validation → Precondition Checks → Version Calculation → File Update → Git Operations
```

Key architectural decisions:

1. **Single-file bash script**: Simple, self-contained, easy to understand and maintain
2. **Fail-fast with `set -e`**: Script exits immediately on any command failure
3. **npm version for updates**: Use `npm version` command to update package.json reliably
4. **Atomic operations**: Use git's transactional nature to ensure consistency
5. **Standard Unix tools**: Maximize portability and minimize dependencies
6. **Default to patch**: If no argument provided, default to patch bump (most common case)

## Components and Interfaces

### Main Script (`scripts/bump-version.sh`)

The script is organized into logical sections following the raven repository pattern:

#### 1. Script Setup

```bash
set -e  # Exit on any error
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
```

Sets up fail-fast behavior and determines repository root directory.

#### 2. Input Validation

```bash
validate_input(bump_type: string) -> exit_code
```

Validates that the bump type argument is one of: `major`, `minor`, `patch`, or an explicit version string. Defaults to `patch` if no argument provided. Displays usage help for `--help` or `-h`. Exits with error code 1 if invalid.

Explicit version format: `X.Y.Z` or `X.Y.Z-suffix` (e.g., `1.0.0-beta.1`)

#### 3. Precondition Validation

```bash
check_git_clean() -> exit_code
```

Verifies that the git working directory is clean (no uncommitted changes). Exits with error code 1 if there are uncommitted changes.

```bash
check_tag_exists(tag: string) -> exit_code
```

Verifies that the target git tag doesn't already exist. Exits with error code 1 if tag exists.

#### 4. Version Reading

```bash
get_current_version() -> version_string
```

Reads the current version from `package.json`. Uses `grep` and `sed` to extract the version field value. Returns the version string (e.g., "0.9.0").

#### 5. Version Calculation

```bash
calculate_new_version(current_version: string, bump_type: string) -> new_version_string
```

If bump_type is an explicit version, validates format and returns it.

Otherwise, parses the current version into major, minor, and patch components. Increments the appropriate component based on bump type:
- `major`: Increment major, reset minor and patch to 0
- `minor`: Increment minor, reset patch to 0
- `patch`: Increment patch (default)

Returns the new version string (e.g., "0.10.0").

#### 6. File Update

```bash
update_package_json(new_version: string) -> exit_code
```

Updates the version field in `package.json` using `npm version` command with `--no-git-tag-version` and `--allow-same-version` flags. This ensures reliable JSON updates while preventing npm from creating its own git operations.

#### 7. Git Operations

```bash
create_git_commit_and_tag(new_version: string) -> exit_code
```

Creates a git commit with message "chore: bump version to X.Y.Z" and a lightweight tag "vX.Y.Z". Does not push automatically (per requirements).

### Error Handling

Each function returns an appropriate exit code (via `set -e` automatic failure):
- `0`: Success
- `1`: Validation or precondition failure
- Non-zero: Command failure (automatic via `set -e`)

Error messages are written to stderr with descriptive context.

## Data Models

### Version String Format

Semantic version format: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-SUFFIX`

- **MAJOR**: Integer >= 0, incremented for breaking changes
- **MINOR**: Integer >= 0, incremented for new features
- **PATCH**: Integer >= 0, incremented for bug fixes
- **SUFFIX**: Optional pre-release identifier (e.g., `beta.1`, `rc.2`)

Examples: `0.9.0`, `1.0.0`, `2.3.15`, `1.0.0-beta.1`

Validation regex: `^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`

### package.json Structure

The script interacts with the version field in package.json:

```json
{
  "name": "mdmarkup",
  "version": "0.9.0",
  ...
}
```

The script must:
- Preserve all other fields unchanged
- Maintain JSON formatting (indentation, spacing)
- Only modify the version field value

### Git Commit and Tag Format

**Commit message**: `chore: bump version to X.Y.Z`

**Tag name**: `vX.Y.Z` (lightweight tag, not annotated)

The script creates a lightweight tag rather than an annotated tag for simplicity, following the raven repository pattern.


## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property 1: Input Validation

*For any* input string, the script should accept it if and only if it is one of "major", "minor", "patch", or a valid semantic version string matching the pattern `^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`. The script should exit with error code 1 for any other input. If no input is provided, it should default to "patch".

**Validates: Requirements 1.1**

### Property 2: Version Calculation Correctness

*For any* valid semantic version string (MAJOR.MINOR.PATCH format), the calculated new version should correctly increment the appropriate component based on bump type:
- major: increment MAJOR, reset MINOR and PATCH to 0
- minor: increment MINOR, reset PATCH to 0  
- patch: increment PATCH only

**Validates: Requirements 1.2**

### Property 3: Version Extraction

*For any* valid package.json file containing a version field, the script should correctly extract the version string value.

**Validates: Requirements 1.2**

### Property 4: File Update Preservation

*For any* package.json file, after updating the version field using `npm version`, all other fields should remain unchanged (only the version value should be modified).

**Validates: Requirements 1.2**

### Property 5: Commit Message Format

*For any* version bump operation, the git commit message should follow the exact format "chore: bump version to X.Y.Z" where X.Y.Z is the new version.

**Validates: Requirements 1.3**

### Property 6: Tag Format

*For any* version bump operation, the git tag should be a lightweight tag with name "vX.Y.Z" where X.Y.Z is the new version.

**Validates: Requirements 1.3**

## Error Handling

The script implements fail-fast error handling using `set -e` with clear error messages:

### Validation Errors

**Invalid bump type**: 
```
ERROR: Invalid version format: foo
Expected format: X.Y.Z or X.Y.Z-suffix
```
Exit code: 1

**Dirty working directory**:
```
ERROR: Working directory is not clean. Commit or stash changes first.
[git status output]
```
Exit code: 1

**Tag already exists**:
```
ERROR: Tag v1.0.0 already exists.
```
Exit code: 1

### File Operation Errors

**Cannot read package.json**:
```
ERROR: Could not read current version from package.json
```
Exit code: 1

**npm version command fails**:
Script exits with npm's error code and message (via `set -e`)

### Git Operation Errors

Git operations fail automatically via `set -e`, displaying git's native error messages.

## Testing Strategy

The version bump script will be tested using a dual approach combining unit tests and property-based tests.

### Unit Tests

Unit tests will verify specific examples and edge cases:

1. **Script location and permissions** - Verify script exists at `scripts/bump-version.sh` with executable permissions
2. **Shebang line** - Verify script starts with `#!/bin/bash`
3. **Usage help display** - Verify usage help is shown for `--help` or `-h` flags
4. **Default to patch** - Verify script defaults to patch bump when no argument provided
5. **Dirty working directory** - Verify script exits with error when git working directory has uncommitted changes
6. **Tag already exists** - Verify script exits with error when target tag already exists
7. **No automatic push** - Verify script does not perform git push operation
8. **Specific version bumps** - Test known version transitions:
   - `0.9.0` → `1.0.0` for major
   - `0.9.0` → `0.10.0` for minor
   - `0.9.0` → `0.9.1` for patch
   - Explicit version: `1.2.3` → `2.0.0`
9. **Pre-release versions** - Test explicit versions with suffixes like `1.0.0-beta.1`

### Property-Based Tests

Property-based tests will verify universal properties across many generated inputs. Each test will run a minimum of 100 iterations.

1. **Property 1: Input Validation** - Generate random strings and verify only valid bump types and semantic versions are accepted
   - Tag: **Feature: version-bump-script, Property 1: Input validation**

2. **Property 2: Version Calculation Correctness** - Generate random semantic versions and verify correct calculation for each bump type
   - Tag: **Feature: version-bump-script, Property 2: Version calculation correctness**

3. **Property 3: Version Extraction** - Generate random package.json files with various formatting and verify version extraction
   - Tag: **Feature: version-bump-script, Property 3: Version extraction**

4. **Property 4: File Update Preservation** - Generate random package.json files, update version, verify all other content unchanged
   - Tag: **Feature: version-bump-script, Property 4: File update preservation**

5. **Property 5: Commit Message Format** - Generate random version bumps and verify commit message format
   - Tag: **Feature: version-bump-script, Property 5: Commit message format**

6. **Property 6: Tag Format** - Generate random version bumps and verify git tag format
   - Tag: **Feature: version-bump-script, Property 6: Tag format**

### Testing Framework

Since this is a bash script, testing will use:
- **Bats** (Bash Automated Testing System) for unit tests
- **Property-based testing** will be implemented using bash test harnesses that generate random inputs
- Tests will be located in `tests/bump-version.test.sh`

Alternatively, since the project uses Bun, we could write tests in TypeScript that shell out to the bash script:
- Use Bun's test runner with fast-check for property-based testing
- Tests would be in `tests/bump-version.test.ts`
- Shell out to the script using `Bun.spawn()` or similar

### Test Execution

Run tests with:
```bash
bun test tests/bump-version.test.ts
```

Or with bats if using bash tests:
```bash
bats tests/bump-version.test.sh
```

## Implementation Notes

### Script Structure

Following the raven repository pattern:

```bash
#!/bin/bash
set -e  # Exit immediately on error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Usage function
usage() { ... }

# Read current version
CURRENT_VERSION=$(grep '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version": "\(.*\)".*/\1/')

# Determine bump type (default to patch)
BUMP="${1:-patch}"

# Calculate or validate new version
case "$BUMP" in
    patch|minor|major) # Calculate new version ;;
    *) VERSION="$BUMP" ;;  # Explicit version
esac

# Validate version format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
    echo "ERROR: Invalid version format: $VERSION"
    exit 1
fi

# Check preconditions
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Working directory is not clean..."
    exit 1
fi

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
    echo "ERROR: Tag v$VERSION already exists."
    exit 1
fi

# Update package.json using npm
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

# Commit and tag
git add package.json package-lock.json
git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"

echo "Version bumped to $VERSION (tag: v$VERSION)"
echo "Run 'git push && git push --tags' to publish"
```

### npm version Command

The script uses `npm version` to update package.json reliably:

```bash
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
```

Flags:
- `--no-git-tag-version`: Prevents npm from creating its own git commit and tag
- `--allow-same-version`: Allows setting the same version (useful for explicit versions)
- `>/dev/null`: Suppresses npm's output for cleaner script output

This approach:
- Handles JSON formatting correctly
- Updates both package.json and package-lock.json if present
- More reliable than manual sed editing
- Standard npm tooling

### Version Parsing for Bump Types

For bump types (major, minor, patch), parse the current version:

```bash
# Strip any pre-release suffix before parsing
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION%%-*}"

case "$BUMP" in
    patch) VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    minor) VERSION="$MAJOR.$((MINOR + 1)).0" ;;
    major) VERSION="$((MAJOR + 1)).0.0" ;;
esac
```

The `${CURRENT_VERSION%%-*}` strips any suffix (e.g., `1.0.0-beta.1` → `1.0.0`) before parsing.

### Git Operations

Git operations are performed in sequence:

```bash
git add package.json
if [ -f package-lock.json ]; then
    git add package-lock.json
fi
git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"
```

The script:
- Stages package.json (always modified)
- Stages package-lock.json if it exists (updated by npm version)
- Creates commit with conventional commit format
- Creates lightweight tag (simpler than annotated)
- Does NOT push (per requirements)

### Idempotency Considerations

The script is not fully idempotent because:
- Running it multiple times will create multiple commits and tags
- Git will reject duplicate tag names (caught by tag existence check)

This is intentional behavior - each version bump should be a distinct operation. The tag existence check prevents accidental duplicate bumps to the same version.
