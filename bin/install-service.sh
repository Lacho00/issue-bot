#!/usr/bin/env bash
# Instala la unidad de usuario de systemd con la carpeta real de este clon.
# Uso: bin/install-service.sh [--no-start]
#   Sin argumentos: escribe la unidad, recarga systemd y activa el servicio.
#   --no-start: solo escribe la unidad y recarga systemd.
# Vuelve a ejecutarlo si mueves el clon o cambia systemd/issue-bot.service.in.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=issue-bot
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$SERVICE.service"

case "${1:-}" in
  ''|--no-start) ;;
  *) echo "uso: $0 [--no-start]" >&2; exit 2 ;;
esac
[[ "$ROOT" != *[@\&\|\\]* ]] || { echo "install-service.sh: la ruta del clon no puede tener @, &, | ni \\: $ROOT" >&2; exit 1; }

mkdir -p "$UNIT_DIR"
tmp="$(mktemp "$UNIT_DIR/.$SERVICE.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed "s|@ROOT@|$ROOT|g" "$ROOT/systemd/$SERVICE.service.in" >"$tmp"
chmod 644 "$tmp"
# Reemplaza también un enlace simbólico de una instalación anterior.
mv -f "$tmp" "$UNIT"
trap - EXIT
echo "Unidad escrita en $UNIT (WorkingDirectory=$ROOT)"

systemctl --user daemon-reload
if [[ "${1:-}" != --no-start ]]; then
  systemctl --user enable --now "$SERVICE"
  echo "Servicio $SERVICE activo. Logs: journalctl --user -u $SERVICE -f"
fi
