#!/bin/bash
#
# Manuscript Markdown Setup Script
# Builds the VSIX package and installs it to supported editors
#
# USAGE:
#   ./setup.sh                    # Build and install to all available editors
#

set -e

# Check for bun
if ! command -v bun &> /dev/null; then
    echo "Error: bun is required but not installed."
    echo "Install via: brew install bun  or  https://bun.sh"
    exit 1
fi

# Check for node
if ! command -v node &> /dev/null; then
    echo "Error: node is required but not installed."
    exit 1
fi

echo "=== Manuscript Markdown Setup ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Install dependencies
echo "Installing dependencies..."
bun install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Step 2: Compile TypeScript
echo "Compiling TypeScript..."
bun run compile
echo -e "${GREEN}✓ TypeScript compiled${NC}"
echo ""

# Step 3: Package the VSIX
echo "Packaging extension..."
bunx vsce package
echo -e "${GREEN}✓ VSIX package built${NC}"
echo ""

# Step 3b: Build CLI binary
echo "Building CLI binary..."
if bun build src/cli.ts --compile --outfile dist/manuscript-markdown; then
  echo -e "${GREEN}✓ CLI binary built${NC}"
  
  # Install CLI to ~/bin
  mkdir -p ~/bin
  cp dist/manuscript-markdown ~/bin/manuscript-markdown
  chmod +x ~/bin/manuscript-markdown
  echo -e "${GREEN}✓ CLI installed to ~/bin/manuscript-markdown${NC}"
else
  echo -e "${RED}CLI compilation failed (continuing with extension install)${NC}" >&2
fi
echo ""

# Find the newest VSIX file
VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="manuscript-markdown-${VERSION}.vsix"

if [ ! -f "$VSIX_FILE" ]; then
    echo -e "${RED}Error: No VSIX file found: $VSIX_FILE${NC}"
    exit 1
fi
echo "Found VSIX: $VSIX_FILE"
echo ""

# Step 4: Install to editors
echo "Installing extension to editors..."
EDITORS=("code" "code-insiders" "codium" "kiro" "antigravity" "cursor" "windsurf")
INSTALLED=0

for editor in "${EDITORS[@]}"; do
    if command -v "$editor" &> /dev/null; then
        echo -n "  $editor: "
        if "$editor" --install-extension "$VSIX_FILE" --force &> /dev/null; then
            echo -e "${GREEN}✓${NC}"
            INSTALLED=$((INSTALLED + 1))
        else
            echo -e "${YELLOW}failed${NC}"
        fi
    else
        echo -e "  $editor: ${YELLOW}not found${NC}"
    fi
done

if [ $INSTALLED -eq 0 ]; then
    echo -e "${YELLOW}Warning: No editors found to install extension${NC}"
else
    echo -e "${GREEN}✓ Extension installed to $INSTALLED editor(s)${NC}"
fi
echo ""

echo "=== Setup Complete ==="
echo "Extension: $VSIX_FILE"
if [ -f "$HOME/bin/manuscript-markdown" ]; then
  echo "CLI: ~/bin/manuscript-markdown"
  case ":$PATH:" in
    *":$HOME/bin:"*) ;;
    *) echo -e "${YELLOW}Note: Add ~/bin to your PATH if not already present${NC}" ;;
  esac
fi
