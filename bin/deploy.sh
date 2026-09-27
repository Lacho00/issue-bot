#!/usr/bin/env bash
# Despliega origin/main en este clon. Uso: npm run deploy [-- --force]
#
# Aquí solo se comprueba y se prueba; el clon no se toca. Si los tests pasan, lanza
# bin/deploy-apply.sh en una unidad transitoria de systemd (issue-bot-deploy), que espera a
# que el bot quede libre, actualiza el árbol y lo arranca. Así el comando vuelve enseguida
# aunque haya un turno largo en curso.
#
# --force despliega aunque origin/main sea el último commit desplegado.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=issue-bot
WORK="$REPO/.deploy"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

die() { echo "deploy: $*" >&2; exit 1; }
cd "$REPO"
# npm run exporta la config del usuario como npm_config_*; el npm ci anidado toma
# allow-scripts como flag de línea de comandos y falla con EALLOWSCRIPTS.
unset npm_config_allow_scripts NPM_CONFIG_ALLOW_SCRIPTS

[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "el clon no está en main; trabaja en un worktree"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "hay cambios sin commitear en el clon"
systemctl --user cat "$SERVICE" >/dev/null 2>&1 || die "el servicio $SERVICE no está instalado (ver README)"
if systemctl --user is-active -q "$SERVICE-deploy"; then die "ya hay un despliegue esperando a que el bot quede libre"; fi

git fetch -q origin main
TARGET="$(git rev-parse origin/main)"
git merge-base --is-ancestor HEAD "$TARGET" || die "main local tiene commits que no están en origin/main"

if [[ $FORCE -eq 0 && -f "$REPO/deployed.sha" && "$(cat "$REPO/deployed.sha")" == "$TARGET" ]] \
  && systemctl --user is-active -q "$SERVICE"; then
  echo "deploy: ${TARGET:0:7} ya está desplegado"
  exit 0
fi

# Tras cada npm ci del despliegue se guarda el hash del lockfile en node_modules/.deploy-lock.sha.
lock_hash() { sha256sum "$1/package-lock.json" | cut -d' ' -f1; }
modules_match() { [[ "$(cat "$1/node_modules/.deploy-lock.sha" 2>/dev/null)" == "$(lock_hash "$1")" ]]; }

echo "deploy: tests sobre ${TARGET:0:7}"
rm -rf "$WORK"
mkdir -p "$WORK"
cleanup() { git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git worktree add -q --detach "$WORK/src" "$TARGET"

# Si el node_modules del clon ya vale para el lockfile nuevo se reutiliza; si no, se instala
# en el worktree y deploy-apply.sh lo mueve al clon con el bot parado.
NEW_MODULES=""
if git diff --quiet HEAD "$TARGET" -- package-lock.json && modules_match "$REPO"; then
  ln -s "$REPO/node_modules" "$WORK/src/node_modules"
else
  (cd "$WORK/src" && npm ci --silent) || die "npm ci falla en ${TARGET:0:7}"
  lock_hash "$WORK/src" >"$WORK/src/node_modules/.deploy-lock.sha"
  NEW_MODULES="$WORK/node_modules"
fi
(cd "$WORK/src" && for f in src/*.js; do node --check "$f" || exit 1; done && npm test >"$WORK/test.log" 2>&1) || { tail -30 "$WORK/test.log" >&2; die "los tests fallan en ${TARGET:0:7}; no despliego"; }
[[ -n "$NEW_MODULES" ]] && mv "$WORK/src/node_modules" "$NEW_MODULES"

# Se ejecuta una copia: el merge reescribe bin/ mientras bash todavía lee el script.
cp "$WORK/src/bin/deploy-apply.sh" "$WORK/deploy-apply.sh"
systemd-run --user --quiet --collect --unit="$SERVICE-deploy" \
  --setenv=PATH="$PATH" --working-directory="$REPO" \
  "$WORK/deploy-apply.sh" "$TARGET" "$NEW_MODULES"
if systemctl --user is-active -q "$SERVICE"; then
  echo "deploy: ${TARGET:0:7} en cola; el bot se reinicia al quedar libre y avisa por Telegram"
else
  echo "deploy: ${TARGET:0:7} en cola; el bot arranca en unos segundos"
fi
echo "deploy: seguimiento con journalctl --user -u $SERVICE-deploy"
