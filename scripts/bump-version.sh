#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    echo "Usage: $0 [major|minor|patch|<version>]"
    echo "Bumps the version in package.json, commits, and tags"
    echo ""
    echo "Arguments:"
    echo "  major         Increment major version (x.0.0)"
    echo "  minor         Increment minor version (x.y.0)"
    echo "  patch         Increment patch version (x.y.z) [default]"
    echo "  <version>     Set explicit version (e.g., 1.2.3 or 1.0.0-beta.1)"
    echo ""
    echo "Options:"
    echo "  -h, --help    Show this help message"
    exit 1
}

# Handle help flags
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
fi

# Default to patch if no argument provided
BUMP_TYPE="${1:-patch}"

# Validate input: either bump type or explicit version
if [[ "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
    # Valid bump type
    :
elif [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    # Valid explicit version
    EXPLICIT_VERSION="$BUMP_TYPE"
else
    echo "Error: Invalid bump type or version '$BUMP_TYPE'"
    usage
fi

cd "$REPO_ROOT"

# Precondition: Check git is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: Working directory is not clean. Commit or stash changes first."
    exit 1
fi

# Get current version using grep/sed
CURRENT_VERSION=$(grep '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Calculate new version
if [[ -n "$EXPLICIT_VERSION" ]]; then
    NEW_VERSION="$EXPLICIT_VERSION"
else
    # Strip pre-release suffix for bump calculations
    BASE_VERSION=$(echo "$CURRENT_VERSION" | sed 's/-.*$//')
    IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"
    
    case "$BUMP_TYPE" in
        major)
            NEW_VERSION="$((MAJOR + 1)).0.0"
            ;;
        minor)
            NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
            ;;
        patch)
            NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
            ;;
    esac
fi

# Validate version format
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo "Error: Invalid version format '$NEW_VERSION'"
    exit 1
fi

TAG="v$NEW_VERSION"

# Precondition: Check tag doesn't exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Error: Tag '$TAG' already exists"
    exit 1
fi

# Update version using npm
npm version "$NEW_VERSION" --no-git-tag-version

# Git operations
git add package.json
if [ -f package-lock.json ]; then
    git add package-lock.json
fi
git commit -m "chore: bump version to $NEW_VERSION"
git tag "$TAG"

echo "✓ Version bumped to $NEW_VERSION"
echo "✓ Committed and tagged as $TAG"
echo ""
echo "To push: git push && git push --tags"
