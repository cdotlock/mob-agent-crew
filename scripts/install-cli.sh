#!/bin/sh

# Install or update the Mob CLI from its source repository without requiring
# root. The checkout is script-managed; local tracked edits are never replaced.

set -eu

REPOSITORY_URL="${MOB_CLI_REPOSITORY_URL:-https://github.com/cdotlock/mob-agent-crew.git}"
REPOSITORY_REF="${MOB_CLI_REF:-main}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
INSTALL_DIR="${MOB_CLI_INSTALL_DIR:-${DATA_HOME}/mob-agent-crew-cli}"
BIN_DIR="${MOB_CLI_BIN_DIR:-${HOME}/.local/bin}"
MOB_BIN="${BIN_DIR}/mob"

fail() {
  printf 'mob installer: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
command -v corepack >/dev/null 2>&1 || fail "corepack is required (it ships with Node.js)"
case "$REPOSITORY_REF" in
  ''|-*) fail "MOB_CLI_REF must be a non-option Git branch or tag" ;;
esac

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "could not determine the Node.js version" ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required; found $(node --version)"

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

[ ! -L "$INSTALL_DIR" ] || fail "$INSTALL_DIR must not be a symbolic link"
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  fail "$INSTALL_DIR already exists and is not a managed Git checkout"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  EXISTING_REMOTE="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$EXISTING_REMOTE" = "$REPOSITORY_URL" ] || \
    fail "$INSTALL_DIR points to $EXISTING_REMOTE, not $REPOSITORY_URL"
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ] || \
    fail "$INSTALL_DIR has tracked local changes; preserve or remove them before updating"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPOSITORY_REF"
  git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD
else
  git clone --depth 1 --branch "$REPOSITORY_REF" -- "$REPOSITORY_URL" "$INSTALL_DIR"
fi

corepack pnpm --dir "$INSTALL_DIR" install --frozen-lockfile
corepack pnpm --dir "$INSTALL_DIR" build
[ -f "$INSTALL_DIR/dist/cli.js" ] || fail "build completed without dist/cli.js"
chmod 0755 "$INSTALL_DIR/dist/cli.js"

if [ -e "$MOB_BIN" ] || [ -L "$MOB_BIN" ]; then
  EXISTING_TARGET="$(readlink "$MOB_BIN" 2>/dev/null || true)"
  [ "$EXISTING_TARGET" = "$INSTALL_DIR/dist/cli.js" ] || \
    fail "$MOB_BIN already exists and was not created by this installer"
else
  ln -s "$INSTALL_DIR/dist/cli.js" "$MOB_BIN"
fi

printf 'Mob CLI installed: %s\n' "$MOB_BIN"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) printf 'Add %s to PATH, then run: mob --help\n' "$BIN_DIR" ;;
esac
