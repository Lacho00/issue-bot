#!/usr/bin/env bash
# Segunda mitad de bin/deploy.sh; corre en la unidad transitoria issue-bot-deploy, como
# copia en .deploy/ y con el clon como directorio de trabajo.
# Uso: deploy-apply.sh <commit> [<node_modules nuevo>]
#
# Pide al bot que salga (SIGUSR2), espera a que se pare, vuelve a comprobar el clon, lo
# avanza, cambia node_modules si hace falta, arranca el servicio y espera a que el bot
# escriba bot.ready. Si algo falla, vuelve al árbol anterior, arranca el bot igual y deja el
# motivo en el aviso de Telegram. Nunca descarta cambios sin commitear.
set -uo pipefail

TARGET="$1"
NEW_MODULES="${2:-}"
REPO="$PWD"
SERVICE=issue-bot
NOTICE="$REPO/deploy-notice.txt"
READY="$REPO/bot.ready"
READY_TIMEOUT=90
cd "$REPO"
PREV="$(git rev-parse HEAD)"
SWAPPED=0

if systemctl --user is-active -q "$SERVICE"; then
  echo "pido la salida al bot"
  systemctl --user kill --kill-whom=main -s SIGUSR2 "$SERVICE"
  while systemctl --user is-active -q "$SERVICE"; do sleep 2; done
  echo "bot parado"
fi

start_and_wait() {
  rm -f "$READY"
  systemctl --user start "$SERVICE" || return 1
  for ((i = 0; i < READY_TIMEOUT; i += 2)); do
    [[ -f "$READY" ]] && return 0
    systemctl --user is-active -q "$SERVICE" || return 1
    sleep 2
  done
  return 1
}

# Sin tocar el árbol: arranca el bot tal como está y deja el motivo.
abort() {
  echo "cancelado: $*" >&2
  echo "despliegue de ${TARGET:0:7} cancelado ($*); sigo en $(git log -1 --format='%h %s')" >"$NOTICE"
  systemctl --user start "$SERVICE"
  exit 1
}

# Deshace lo que este script cambió y arranca el bot con el árbol anterior.
fail() {
  echo "fallo: $*" >&2
  systemctl --user stop "$SERVICE" 2>/dev/null
  if [[ $SWAPPED -eq 1 && -e node_modules.old ]]; then
    rm -rf node_modules
    mv node_modules.old node_modules
  fi
  # --keep no pisa cambios sin commitear: si chocaran, falla y el árbol se queda como está.
  if [[ "$(git rev-parse HEAD)" != "$PREV" ]]; then git reset -q --keep "$PREV"; fi
  echo "despliegue de ${TARGET:0:7} fallido ($*); sigo en $(git log -1 --format='%h %s')" >"$NOTICE"
  systemctl --user start "$SERVICE"
  exit 1
}

# La espera puede durar lo que un turno: el clon se vuelve a comprobar ahora.
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || abort "el clon ya no está en main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || abort "hay cambios sin commitear en el clon"
git merge-base --is-ancestor HEAD "$TARGET" || abort "main local no avanza a ${TARGET:0:7}"

git merge -q --ff-only "$TARGET" || fail "git merge --ff-only"
if [[ -n "$NEW_MODULES" ]]; then
  rm -rf node_modules.old
  [[ -e node_modules ]] && mv node_modules node_modules.old
  SWAPPED=1
  mv "$NEW_MODULES" node_modules || fail "cambio de node_modules"
fi

systemctl --user daemon-reload
git log -1 --format='%h %s' "$TARGET" >"$NOTICE"
start_and_wait || fail "el bot no arrancó"
rm -rf node_modules.old "$REPO/.deploy"
echo "$TARGET" >"$REPO/deployed.sha"
echo "desplegado ${TARGET:0:7}"
