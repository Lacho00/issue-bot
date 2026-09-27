#!/usr/bin/env bash
# Despliega origin/main en este clon y reinicia el bot cuando quede libre.
#
# 1. Exige estar en main sin cambios en ficheros versionados.
# 2. Pasa los tests sobre origin/main en un worktree temporal, antes de tocar el clon.
# 3. Avanza main (solo fast-forward) y ejecuta npm ci si cambió el lockfile.
# 4. Pide el reinicio con SIGUSR2: el bot termina el turno en curso, sale y systemd lo
#    vuelve a arrancar. Al arrancar avisa por Telegram con el commit desplegado.
#
# --force despliega aunque origin/main sea el último commit desplegado.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=issue-bot
STAMP="$REPO/deployed.sha"
NOTICE="$REPO/deploy-notice.txt"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

die() { echo "deploy: $*" >&2; exit 1; }
cd "$REPO"

[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "el clon no está en main; trabaja en un worktree"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "hay cambios sin commitear en el clon"
systemctl --user cat "$SERVICE" >/dev/null 2>&1 || die "el servicio $SERVICE no está instalado (ver README)"

git fetch -q origin main
TARGET="$(git rev-parse origin/main)"
git merge-base --is-ancestor HEAD "$TARGET" || die "main local tiene commits que no están en origin/main"

if [[ $FORCE -eq 0 && -f "$STAMP" && "$(cat "$STAMP")" == "$TARGET" ]] && systemctl --user is-active -q "$SERVICE"; then
  echo "deploy: $TARGET ya está desplegado"
  exit 0
fi

echo "deploy: tests sobre ${TARGET:0:7}"
TMP="$(mktemp -d)"
cleanup() { git -C "$REPO" worktree remove --force "$TMP/src" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
git worktree add -q --detach "$TMP/src" "$TARGET"
if git diff --quiet HEAD "$TARGET" -- package-lock.json && [[ -d "$REPO/node_modules" ]]; then
  ln -s "$REPO/node_modules" "$TMP/src/node_modules"
else
  (cd "$TMP/src" && npm ci --silent)
fi
(cd "$TMP/src" && npm test >"$TMP/test.log" 2>&1) || { tail -30 "$TMP/test.log" >&2; die "los tests fallan en ${TARGET:0:7}; no despliego"; }

LOCK_CHANGED=0
git diff --quiet HEAD "$TARGET" -- package-lock.json || LOCK_CHANGED=1
git merge -q --ff-only "$TARGET"
[[ $LOCK_CHANGED -eq 1 ]] && npm ci --silent

systemctl --user daemon-reload
git log -1 --format='%h %s' "$TARGET" >"$NOTICE"
if systemctl --user is-active -q "$SERVICE"; then
  systemctl --user kill --kill-whom=main -s SIGUSR2 "$SERVICE"
  echo "deploy: reinicio pedido; el bot sale al quedar libre y systemd lo arranca"
else
  systemctl --user start "$SERVICE"
  echo "deploy: servicio arrancado"
fi
echo "$TARGET" >"$STAMP"
