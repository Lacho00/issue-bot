# issue-bot

Bot de Telegram que recibe issues de un sitio de `/srv/http`, acuerda un plan por chat,
aplica el arreglo en local con Claude Code y devuelve un informe HTML de antes y después.

## Instalación

1. `npm install`
2. Crear `.env` (permisos 600):

   ```
   TELEGRAM_TOKEN=<token de BotFather>
   OWNER_ID=
   ```

3. Escribir al bot en privado. El primer mensaje registra tu user ID en `OWNER_ID`.
4. Servicio:

   ```
   ln -sf /srv/http/issue-bot/systemd/issue-bot.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now issue-bot
   loginctl enable-linger "$USER"   # para que arranque sin sesión abierta
   ```

## Uso

- `/nuevo <sitio>`: abre un trabajo sobre `/srv/http/<sitio>`.
- Manda textos y capturas. Termina con `/plan` o «eso es todo».
- Discute el plan por chat y pulsa **Aprobar plan**.
- Recibes `informe-<sitio>-<fecha>.html`. Correcciones: escríbelas. Si no, `/cerrar`.
- `/estado`, `/cancelar`.

Diseño: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md`.
Logs: `journalctl --user -u issue-bot -f`.
