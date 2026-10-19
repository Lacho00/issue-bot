<p align="center"><img src="docs/brand/logo-mark.svg" width="160" alt=""></p>

# issue-bot

[English](README.md) · Español

**¿Primera vez? Lee la [guía paso a paso](docs/GUIDE.es.md)** (también en [inglés](docs/GUIDE.md)).

Bot de Telegram que recibe issues de un sitio de `/srv/http`, acuerda un plan por chat,
aplica el arreglo en local con Claude Code y devuelve un informe HTML de antes y después.

## Instalación

Requiere Linux con servicios de usuario de systemd, Node.js 22 o posterior, `bwrap`, WP-CLI (`wp`),
Chromium e ImageMagick (`magick`). Recomendado: el servidor MCP de Playwright. Y `claude`
instalado y con sesión iniciada (`claude login`) para el usuario que ejecuta el servicio: el bot
lo invoca sin terminal para atender cada turno.

1. `npm install`
2. Crear `.env` (permisos 600):

   ```
   TELEGRAM_TOKEN=<token de BotFather>
   OWNER_ID=
   CHAT_ID=
   ```

   Claves opcionales, con sus valores por defecto:

   ```
   BOT_LANG=es
   SITES_ROOT=/srv/http
   AUDITS_ROOT=~/audits
   CLAUDE_BIN=claude
   CHROMIUM_BIN=chromium
   BOT_SOCKET=<carpeta del bot>/bot.sock
   BATCH_IDLE_MS=120000
   VHOST_DIR=/etc/httpd/conf/extra
   ```

   `BOT_LANG`: `es` o `en`. Idioma de los mensajes del bot, de las respuestas de Claude y del
   informe HTML.
   `CHROMIUM_BIN`: `chromium`, `chromium-browser`, `google-chrome` o `google-chrome-stable`; con
   otro valor el bot sale al arrancar (el paquete snap de Ubuntu es `chromium-browser`).
   `BATCH_IDLE_MS`: milisegundos sin mensajes nuevos tras los que se cierra el lote.
   `VHOST_DIR`: carpeta de los vhosts de Apache (`httpd-*.conf`) que se usan para detectar el sitio.

3. Servicio:

   ```
   bin/install-service.sh
   loginctl enable-linger "$USER"   # para que arranque sin sesión abierta
   ```

   El script escribe `~/.config/systemd/user/issue-bot.service` a partir de
   `systemd/issue-bot.service.in` con la ruta real del clon, recarga systemd y ejecuta
   `enable --now`. Con `--no-start` solo escribe la unidad. Vuelve a ejecutarlo si mueves el clon.

4. Escribir al bot en privado. El primer mensaje registra tu user ID en `OWNER_ID`.

   La unidad arranca `bin/start.sh`, que usa el node del alias `default` de nvm (o el del
   `PATH` si no hay nvm). Si el bot cae por un fallo inesperado sale con código 70 y systemd lo
   vuelve a arrancar; con código 1 (falta el token, no hay node) no lo reintenta.

## Despliegue

`npm run deploy` (`bin/deploy.sh`) despliega `origin/main` en este clon:

1. Exige que el clon esté en `main` y sin cambios en ficheros versionados.
2. Pasa `npm test` sobre `origin/main` en un worktree temporal (`.deploy/`). Si falla, no
   toca nada. Si el lockfile cambió, instala ahí el `node_modules` nuevo.
3. Lanza `bin/deploy-apply.sh` en la unidad transitoria `issue-bot-deploy` y vuelve enseguida.
4. `deploy-apply.sh` manda `SIGUSR2` al bot. El bot deja de abrir turnos y sale cuando no hay
   turno ni mensaje en curso. Entonces avanza `main` con fast-forward, cambia `node_modules` si
   hace falta y arranca el servicio. El árbol no cambia mientras corre un turno.
5. Al arrancar, el bot avisa por Telegram: «Bot actualizado a <commit>». Si algo falla con el bot
   parado, vuelve al commit anterior, lo arranca igual y el aviso dice por qué.

Si el commit ya está desplegado no hace nada; `--force` lo repite. Seguimiento:
`journalctl --user -u issue-bot-deploy`. No hay disparo automático: se lanza tras fusionar o
hacer push a `main` (ver `CLAUDE.md`). GitHub Actions pasa los tests en cada PR y en cada push a
`main` (`.github/workflows/test.yml`).

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
- `/estado`, `/cancelar`, `/cerrar`. Sin trabajo abierto, `/cerrar` descarta el lote guardado.
- Los alias en inglés funcionan también: `/new <sitio>`, `/status`, `/cancel`, `/close`, y
  «that's all» cierra el lote.
- Al arrancar, el bot solo escribe si hay despliegue nuevo o trabajo abierto. Un lote guardado sin
  sitio no se anuncia: lo retoman `/plan` o el siguiente mensaje.

Logs: `journalctl --user -u issue-bot -f`.
Tras actualizar el código: `systemctl --user restart issue-bot`.

## Seguridad

El bot ejecuta Claude Code sobre los ficheros de tus sitios a partir de mensajes de Telegram.
Trátalo como un acceso remoto a esa máquina:

- **Solo atiende a una persona.** Con `OWNER_ID` vacío, el primer mensaje que recibe (en privado
  o en un grupo) registra a su remitente como dueño. Arráncalo y escríbele tú enseguida, o rellena `OWNER_ID`
  a mano antes de arrancarlo. Después ignora a cualquier otro usuario y cualquier otro chat.
- **El token es la llave.** Quien tenga `TELEGRAM_TOKEN` puede suplantar al bot. Deja `.env`
  con permisos 600 y fuera del repo (ya está en `.gitignore`).
- **No hay commits ni push.** Los cambios se quedan en el árbol de trabajo del sitio para que
  los revises tú. La política de abajo deniega `git commit`, `push` y las órdenes destructivas.
- **Pensado para local.** Úsalo sobre copias de desarrollo, no sobre producción.

## Permisos

Cada turno carga los settings del usuario, del proyecto y locales del sitio
(`--setting-sources user,project,local`), así que el `CLAUDE.md` del sitio se carga solo, más la
lista del bot. Como un settings del sitio puede permitir comandos por su cuenta, la política del
bot la aplica un hook `PreToolUse` (`src/policy-hook.js`) que corre antes que cualquier allow:

- Deniega `git commit`, `push`, `add`, `restore`, `checkout` (salvo `-b`), `reset --hard`,
  `clean`, `diff --no-index` y `--output`; `wp db drop`, `reset` e `import`; instalar
  Playwright; `file://`; y tocar el directorio del bot. Tampoco se edita nada bajo `.claude`
  ni `.git`, ni el `.mcp.json` del sitio.
- Bash corre en el sandbox de Claude Code (bwrap, `failIfUnavailable`). Dentro del sandbox no hay
  red, y solo se escribe en el sitio y en la carpeta del trabajo; en la fase de plan, en ninguno de
  los dos. Tampoco se escribe en `.git`, `.claude` ni `.mcp.json`, y no se lee el `.env` del bot.
  Lo que corre ahí se aprueba solo, incluidos los comandos compuestos y los scripts (`magick`, `node`…).
- `wp` y `chromium` corren fuera del sandbox: necesitan el socket de MySQL y el loopback del sitio
  local. Pasan por la lista del bot. Si van compuestos, la primera orden tiene que estar en la
  lista, y cada una de las demás también, o ser un filtro de la entrada estándar sin ficheros
  (`head`, `tail`, `wc`, `grep <patrón>`).
  Si hay `$(…)`, variables, subshell o redirecciones (salvo a `/dev/null` y `2>&1`), se pregunta.
- También pregunta los cambios en `package.json`, `composer.json`, `.npmrc`,
  `*.config.{js,cjs,mjs,ts}` y `wp-cli*.yml`,
  toda edición en la fase de plan y, al implementar, la que caiga fuera del sitio y de la
  carpeta del trabajo.

Si los settings del sitio, del usuario o gestionados tienen `disableAllHooks` o cualquier clave
`sandbox` (el sandbox lo define solo el bot), el bot no arranca el turno. Lo que no cubre ninguna
lista se pide con los botones Permitir y Denegar. Debajo va un tercer botón, «Permitir … en este
trabajo», solo para órdenes sueltas. Recuerda el comando base (con su subcomando en `git` y `npm`,
y con dos en `wp`: `wp post list`), o la carpeta de la edición, hasta que se cierra el trabajo.
No aparece para `chromium` ni para `wp eval`, `shell`, `db` o con `--exec`. Las prohibiciones siguen mandando. El
recuerdo vive en memoria, así que un despliegue o un reinicio lo borra.

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

## Licencia

MIT. Ver [LICENSE](LICENSE).
