#!/bin/sh
set -eu

ensure_real_dir() {
  path="$1"
  mode="$2"
  if [ -L "$path" ]; then
    echo "Refusing symbolic-link runtime directory: $path" >&2
    exit 1
  fi
  install -d -m "$mode" -o root -g root "$path"
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    echo "Runtime directory is not a real directory: $path" >&2
    exit 1
  fi
}

if [ "$(id -u)" = "0" ]; then
  control_dir="${MOB_CONTROL_DIR:-/run/mob-control}"
  ensure_real_dir "$control_dir" 0700
  ensure_real_dir /data/tasks 0711
  ensure_real_dir /data/control 0700
  ensure_real_dir /data/control/tasks 0700
  # Agent profiles are secret-free, but the dedicated UID must be able to
  # traverse the parent left by older node-owned Railway volumes.
  ensure_real_dir /data/agents 0711
  ensure_real_dir /data/state 0700
  ensure_real_dir /data/artifacts 0700
  mob_ai_key_file=""
  github_token_file=""

  if [ -n "${MOB_AI_KEY:-}" ]; then
    umask 077
    printf '%s' "$MOB_AI_KEY" > "$control_dir/mob-ai-key"
    chown root:root "$control_dir/mob-ai-key"
    unset MOB_AI_KEY
    mob_ai_key_file="$control_dir/mob-ai-key"
  fi

  if [ -n "${GH_TOKEN:-}" ]; then
    umask 077
    printf '%s' "$GH_TOKEN" > "$control_dir/github-token"
    chown root:root "$control_dir/github-token"
    unset GH_TOKEN
    github_token_file="$control_dir/github-token"
  fi

  if [ -n "$mob_ai_key_file" ] && [ -n "$github_token_file" ]; then
    exec env -u MOB_AI_KEY -u GH_TOKEN \
      MOB_AI_KEY_FILE="$mob_ai_key_file" GH_TOKEN_FILE="$github_token_file" "$@"
  fi
  if [ -n "$mob_ai_key_file" ]; then
    exec env -u MOB_AI_KEY -u GH_TOKEN MOB_AI_KEY_FILE="$mob_ai_key_file" "$@"
  fi
  if [ -n "$github_token_file" ]; then
    exec env -u MOB_AI_KEY -u GH_TOKEN GH_TOKEN_FILE="$github_token_file" "$@"
  fi
  exec env -u MOB_AI_KEY -u GH_TOKEN "$@"
fi

exec "$@"
