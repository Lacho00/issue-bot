#!/usr/bin/env bash
# Segunda mitad de bin/deploy.sh; corre en la unidad transitoria issue-bot-deploy, como
# copia en .deploy/ y con el clon como directorio de trabajo.
# Uso: deploy-apply.sh <commit> [<node_modules nuevo>]
#
# Pide al bot que salga (SIGUSR2), espera a que se pare, avanza el clon, cambia node_modules
# si hace falta y arranca el servicio. Si algo falla con el bot parado, lo arranca igual con
# el árbol anterior y deja el motivo en el aviso de Telegram.
set -uo pipefail

TARGET="$1"
NEW_MODULES="${2:-}"
REPO="$PWD"
SERVICE=issue-bot
NOTICE="$REPO/deploy-notice.txt"
cd "$REPO"
PREV="$(git rev-parse HEAD)"

if systemctl --user is-active -q "$SERVICE"; then
  echo "pido la salida al bot"
  systemctl --user kill --kill-whom=main -s SIGUSR2 "$SERVICE"
  while systemctl --user is-active -q "$SERVICE"; do sleep 2; done
  echo "bot parado"
fi

fail() {
  echo "fallo: $*" >&2
  git reset -q --hard "$PREV"
  echo "despliegue de ${TARGET:0:7} fallido ($*); sigo en $(git log -1 --format='%h %s')" >"$NOTICE"
  systemctl --user start "$SERVICE"
  exit 1
}

git merge -q --ff-only "$TARGET" || fail "git merge --ff-only"
if [[ -n "$NEW_MODULES" ]]; then
  rm -rf node_modules.old
  [[ -e node_modules ]] && mv node_modules node_modules.old
  mv "$NEW_MODULES" node_modules || { [[ -e node_modules.old ]] && mv node_modules.old node_modules; fail "cambio de node_modules"; }
  rm -rf node_modules.old
fi

systemctl --user daemon-reload
git log -1 --format='%h %s' "$TARGET" >"$NOTICE"
systemctl --user start "$SERVICE" || exit 1
echo "$TARGET" >"$REPO/deployed.sha"
rm -rf "$REPO/.deploy"
echo "desplegado ${TARGET:0:7}"
