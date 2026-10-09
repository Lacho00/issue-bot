#!/usr/bin/env bash
# Arranque del servicio. Busca el node del alias `default` de nvm, así la unidad no fija una
# versión concreta y sigue funcionando al actualizar node. Sin nvm usa el node del PATH.
# Uso: bin/start.sh [argumentos de node]; sin argumentos arranca src/bot.js.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export NVM_DIR="${NVM_DIR:-$HOME/.config/nvm}"
NODE=""
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # nvm.sh no tolera nounset.
  set +u
  . "$NVM_DIR/nvm.sh" --no-use
  NODE="$(nvm which default 2>/dev/null || true)"
  set -u
fi
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || { echo "start.sh: no encuentro node" >&2; exit 1; }

# Los hooks y el servidor MCP que lanza claude -p ejecutan `node`: tiene que ser el mismo.
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
if [[ $# -eq 0 ]]; then set -- src/bot.js; fi
exec "$NODE" "$@"
