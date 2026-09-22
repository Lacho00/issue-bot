# issue-bot

Bot de Telegram que recibe issues de un sitio de `/srv/http`, acuerda un plan por chat,
aplica el arreglo en local con Claude Code y devuelve un informe HTML de antes y después.

## Instalación

Requiere `claude` instalado y con sesión iniciada (`claude login`) para el usuario
que ejecuta el servicio: el bot lo invoca sin terminal para atender cada turno.

1. `npm install`
2. Crear `.env` (permisos 600):

   ```
   TELEGRAM_TOKEN=<token de BotFather>
   OWNER_ID=
   CHAT_ID=
   ```

   Claves opcionales, con sus valores por defecto:

   ```
   SITES_ROOT=/srv/http
   AUDITS_ROOT=/home/lacho/audits
   CLAUDE_BIN=claude
   BOT_SOCKET=<carpeta del bot>/bot.sock
   ```

3. Escribir al bot en privado. El primer mensaje registra tu user ID en `OWNER_ID`.
4. Servicio:

   ```
   mkdir -p ~/.config/systemd/user
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

## Grupo

El bot también puede hablar en un grupo de Telegram en vez de en privado:

1. Con BotFather, `/setprivacy` → **Disable** para este bot. Si no, en un grupo solo
   recibe comandos (`/plan`, etc.), no textos sueltos ni capturas.
2. Quita el bot del grupo y vuelve a añadirlo (para que el cambio de privacidad
   surta efecto).
3. El primer mensaje que el bot reciba en ese grupo registra a su remitente como
   dueño (`OWNER_ID`) y ese chat como `CHAT_ID`. A partir de ahí solo atiende al
   dueño y solo en ese chat (o en privado, si nunca se registró un grupo).
4. El resto de personas del grupo pueden leer todo lo que el bot publique ahí.
