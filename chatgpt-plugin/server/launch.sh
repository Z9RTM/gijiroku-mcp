#!/bin/sh
set -eu
if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ]; then
  echo 'gijiroku-mcp requires an Apple Silicon Mac.' >&2
  exit 1
fi
: "${HOME:?HOME must point to the user home directory}"
server_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$server_dir/gijiroku-mcp" \
  "$server_dir/speech" \
  "$HOME/Library/Application Support/gijiroku-mcp/chatgpt" \
  "$HOME/Library/Application Support/gijiroku-mcp/models"
