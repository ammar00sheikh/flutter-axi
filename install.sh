#!/usr/bin/env bash
# flutter-axi installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ammar00sheikh/flutter-axi/main/install.sh | bash
#
# Clones (or updates) the repo into $FLUTTER_AXI_HOME (default ~/.flutter-axi/cli),
# builds it, and links the `flutter-axi` binary onto PATH via npm link.
# Requirements: git, Node >= 20, npm. Dart SDK >= 3.9 is needed at runtime.
set -euo pipefail

INSTALL_DIR="${FLUTTER_AXI_HOME:-$HOME/.flutter-axi/cli}"
REPO="${FLUTTER_AXI_REPO:-https://github.com/ammar00sheikh/flutter-axi.git}"

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "error: npm (Node >= 20) is required" >&2; exit 1; }

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  echo "error: Node >= 20 is required (found $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing install in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning into $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "Installing dependencies..."
npm install --no-fund --no-audit
echo "Building..."
npm run build
echo "Linking flutter-axi onto PATH..."
npm link

echo
echo "flutter-axi $(flutter-axi -v) installed."
if ! command -v dart >/dev/null; then
  echo "note: dart was not found on PATH - install a Dart/Flutter SDK (>= 3.9)"
  echo "      or set FLUTTER_AXI_DART_BIN to your SDK's dart binary."
fi
echo "Next: flutter-axi setup driver <your-flutter-project>, then flutter-axi devices"
