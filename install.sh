#!/usr/bin/env bash
set -euo pipefail

REPO="ihornone-sandbox/cc-proxy"
INSTALL_DIR="${OPENCODE_INSTALL_DIR:-$HOME/.cc-proxy}"

echo "Installing cc-proxy..."

# Ensure Node.js is available
if ! command -v node &>/dev/null; then
  echo "Error: Node.js >= 18 is required. Install it from https://nodejs.org"
  exit 1
fi

# Clone or pull
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# Install dependencies
cd "$INSTALL_DIR"
npm install --production

# Create symlink
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/index.js" "$HOME/.local/bin/cc-proxy"

echo ""
echo "Done! Make sure ~/.local/bin is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Run the proxy:"
echo "  cc-proxy"
echo ""
echo "Check that Command Code is authenticated:"
echo "  cmd login   # if not already"
