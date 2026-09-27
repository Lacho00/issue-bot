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
   BATCH_IDLE_MS=120000
   VHOST_DIR=/etc/httpd/conf/extra
   ```

   `BATCH_IDLE_MS`: milisegundos sin mensajes nuevos tras los que se cierra el lote.
   `VHOST_DIR`: carpeta de los vhosts de Apache (`httpd-*.conf`) que se usan para detectar el sitio.

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

- Reenvía al chat los mensajes de la QA (textos, capturas, álbumes). El bot saca los hosts de
  las URLs y los busca en el `.wp-create.json` de cada sitio (`project.domain`,
  `wordpress.url`, `wordpress.url_origin`) y en los vhosts de `VHOST_DIR` (`ServerName`,
  `ServerAlias`). Si coincide un solo sitio abre el trabajo: «Trabajo abierto en X (detectado
  por <host>)». Si coinciden varios, o el host no está en el índice, elige en los botones o
  usa `/nuevo <sitio>`. El bot nunca crea sitios ni adivina uno.
- `/nuevo <sitio>`: abre un trabajo sobre `/srv/http/<sitio>` a mano. Mientras el lote se está
  recogiendo, gana a la detección.
- El lote se cierra solo tras 2 minutos sin mensajes (`BATCH_IDLE_MS`), o en el acto con `/plan`
  o «eso es todo». Si al cerrarse no hay sitio, el bot pregunta y conserva el lote.
- Si reenvías algo de otro sitio con un lote abierto, el bot pregunta: **Cambiar a Y** o
  **Añadir a X**.
- Discute el plan por chat y pulsa **Aprobar plan**.
- Recibes `informe-<sitio>-<fecha>.html` y una línea de estado por issue. Claude escribe
  `informe.json` en la carpeta del trabajo y el bot lo convierte en HTML con el estilo del informe
  de `/wp-audit`: KPIs por estado y una tarjeta por issue con el mensaje de la QA y las fotos
  **Antes** (las de la QA) y **Después** (capturas de Claude) lado a lado. Si no hay
  `informe.json`, usa `informe.md` como respaldo. Después:
  - lo que escribas tú es una corrección: nueva ronda del mismo trabajo;
  - un reenvío es un lote nuevo de QA: cierra el trabajo y abre otro para el sitio detectado.
- Los reenvíos que llegan mientras Claude trabaja, o con un plan sin aprobar, se guardan para el
  siguiente lote («Guardado para el siguiente lote»).
- `/estado`, `/cancelar`, `/cerrar`.

Diseño: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md` y
`docs/superpowers/specs/2026-09-22-qa-forward-flow-design.md`.
Logs: `journalctl --user -u issue-bot -f`.
Tras actualizar el código: `systemctl --user restart issue-bot`.

## Permisos

Cada turno carga los settings del usuario, del proyecto y locales del sitio
(`--setting-sources user,project,local`), así que el `CLAUDE.md` del sitio se carga solo, más la
lista del bot. Como un settings del sitio puede permitir comandos por su cuenta, la política del
bot la aplica un hook `PreToolUse` (`src/policy-hook.js`) que corre antes que cualquier allow:

- Deniega `git commit`, `push`, `add`, `restore`, `checkout` (salvo `-b`), `reset --hard`,
  `clean`, `diff --no-index` y `--output`; `wp db drop`, `reset` e `import`; instalar
  Playwright; `file://`; y tocar el directorio del bot. Tampoco se edita nada bajo `.claude`
  ni `.git`, ni el `.mcp.json` del sitio.
- Pregunta por Telegram cualquier Bash fuera de la lista del bot o que componga órdenes
  (`;`, `&&`, `|`, redirecciones, `$(…)`); de `npm run` solo pasa sin preguntar `npm run build` exacto.
  También pregunta los cambios en `package.json`, `composer.json`, `.npmrc`,
  `*.config.{js,cjs,mjs,ts}` y `wp-cli*.yml`,
  toda edición en la fase de plan y, al implementar, la que caiga fuera del sitio y de la
  carpeta del trabajo.

Si los settings del sitio o del usuario tienen `disableAllHooks`, el bot no arranca el turno.
Lo que no cubre ninguna lista se pide con botones Permitir/Denegar.

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
5. Los reenvíos que hace el dueño en ese chat se aceptan, venga de quien venga el mensaje
   original. Los reenvíos de otras personas se ignoran.
