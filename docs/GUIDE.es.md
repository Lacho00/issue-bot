# Guía de issue-bot

[English](GUIDE.md) · Español

Esta guía te lleva de una máquina vacía a tu primer issue de QA corregido. Cubre la instalación,
una conversación de ejemplo, el informe, los grupos, las actualizaciones, los problemas
frecuentes y la desinstalación. El [README](../README.es.md) tiene la versión corta y los detalles
de seguridad y permisos.

## Contenido

1. [Qué hace](#1-qué-hace)
2. [Requisitos](#2-requisitos)
3. [Cómo se encuentran los sitios](#3-cómo-se-encuentran-los-sitios)
4. [Crear el bot de Telegram y configurarlo](#4-crear-el-bot-de-telegram-y-configurarlo)
5. [Primer arranque](#5-primer-arranque)
6. [Tu primer trabajo](#6-tu-primer-trabajo)
7. [El informe](#7-el-informe)
8. [Usarlo en un grupo de Telegram](#8-usarlo-en-un-grupo-de-telegram)
9. [Actualizar](#9-actualizar)
10. [Problemas frecuentes](#10-problemas-frecuentes)
11. [Seguridad y desinstalación](#11-seguridad-y-desinstalación)

## 1. Qué hace

issue-bot es un bot de Telegram que corre en tu máquina Linux. Una persona de QA reporta fallos
de un sitio WordPress local. Tú reenvías esos mensajes al bot. El bot maneja Claude Code, que lee
el sitio, propone un plan y, cuando lo apruebas, corrige el código y mide el resultado.

Es para desarrolladores que reciben el feedback de QA como mensajes de chat con capturas, y
quieren una primera corrección y un informe escrito sin salir de Telegram.

> **Aviso: solo copias locales de desarrollo.** El bot ejecuta Claude Code sobre los ficheros de
> tus sitios, a partir de mensajes de Telegram. No lo apuntes nunca a un servidor de producción
> ni a un sitio que no puedas permitirte romper. Deja todos los cambios sin commitear en el
> árbol de trabajo para que los revises, pero trata al bot como un acceso remoto a la máquina
> donde corre.

El flujo:

1. Reenvía al bot los mensajes de la QA (textos, capturas, álbumes).
2. El bot saca los hosts de las URLs y detecta a qué sitio pertenecen.
3. Recoge los mensajes en un lote. El lote se cierra tras una pausa, o cuando mandas `/plan`.
4. Claude lee el sitio y envía un plan. Puedes discutirlo por chat.
5. Pulsas **Aprobar plan**.
6. Claude corrige el código, hace las capturas del «Después» y escribe los datos del informe.
7. El bot envía un informe HTML con la captura de la QA y la nueva, lado a lado.
8. Lo que escribas después es una corrección y abre otra ronda. `/cerrar` termina el trabajo.

## 2. Requisitos

El bot solo funciona en Linux. Necesitas un usuario con servicios de usuario de systemd.

| Requisito | Para qué |
|---|---|
| Node.js 22 o posterior | Ejecuta el bot. nvm sirve. |
| CLI de Claude Code con sesión iniciada | El bot lanza `claude` sin terminal en cada turno. |
| bubblewrap (`bwrap`) | El sandbox de Claude Code para los comandos de shell. |
| WP-CLI (`wp`) | Claude lo usa para inspeccionar y cambiar el sitio. |
| Chromium | Claude lo usa para renderizar páginas. |
| ImageMagick (`magick`) | Claude recorta las capturas con él. |
| Servicios de usuario de systemd | Mantienen el bot en marcha. |

Opcionales, pero recomendados:

- El servidor MCP de Playwright, configurado en Claude Code. Los prompts del bot le piden a Claude
  que mida y haga capturas con las herramientas `mcp__playwright`.
- El servidor MCP codebase-memory. Claude lo usa si está disponible.

Sin Playwright MCP, las capturas del «Antes» y del «Después» saldrán mal o no saldrán.

### Arch Linux

```
sudo pacman -S --needed nodejs npm bubblewrap chromium imagemagick git
# WP-CLI está en el AUR (wp-cli), o instala el phar (ver más abajo)
```

### Ubuntu / Debian

```
sudo apt update
sudo apt install -y bubblewrap imagemagick git curl
```

Chromium. En Debian, `sudo apt install chromium` instala el binario `chromium`. En Ubuntu, el
paquete `chromium-browser` es un envoltorio de snap. Está permitido, pero tienes que poner
`CHROMIUM_BIN=chromium-browser` en `.env` (paso 4). El confinamiento de snap puede impedir que
Chromium lea ficheros locales, así que pruébalo tras instalarlo. Google Chrome
(`google-chrome-stable`) también sirve.

### Node.js 22 (cualquier distribución, con nvm)

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# abre una shell nueva y luego:
nvm install 22
nvm alias default 22
```

`bin/start.sh` usa el node del alias `default` de nvm, o el del `PATH` si no hay nvm.

### WP-CLI

Si tu distribución no tiene paquete:

```
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod +x wp-cli.phar
sudo mv wp-cli.phar /usr/local/bin/wp
wp --info
```

### Claude Code

Instala la CLI como indica la documentación de Claude Code y luego inicia sesión con el usuario
que ejecutará el bot:

```
claude login
claude --version
```

El servicio corre con ese mismo usuario y usa la misma sesión.

### Playwright MCP (opcional)

Añade el servidor a Claude Code en el ámbito de usuario, con el Chromium que ya tienes. No dejes
que descargue otro navegador.

```
claude mcp add --scope user playwright -- npx @playwright/mcp@latest --browser chromium --executable-path /usr/bin/chromium
claude mcp list
```

Ajusta `--executable-path` a tu Chromium. Si el comando falla, mira la sintaxis exacta de
`mcp add` en tu versión de Claude Code.

### Comprueba las herramientas

```
node --version        # v22 o posterior
claude --version
bwrap --version
wp --version
chromium --version    # o chromium-browser / google-chrome-stable
magick -version
```

### Mantén el bot en marcha sin sesión abierta

```
loginctl enable-linger "$USER"
```

Sin esto, systemd para tus servicios de usuario cuando cierras la sesión.

## 3. Cómo se encuentran los sitios

El bot busca los sitios en `SITES_ROOT` (por defecto `/srv/http`). Cada sitio es una carpeta:
`SITES_ROOT/<sitio>`. El nombre de la carpeta es el que usas en `/nuevo <sitio>`.

Cada sitio debería ser un repositorio git o un árbol de trabajo. El bot mira `git status` al
abrir un trabajo y avisa si hay cambios sin commitear. Claude deja sus cambios sin commitear. El
bot deniega `git commit` y `git push`.

Para elegir el sitio a partir de los mensajes de la QA, el bot saca los hosts de las URLs y los
busca en dos sitios.

**1. `.wp-create.json` en la carpeta del sitio.** El bot lee estas claves:

- `project.domain`
- `wordpress.url`
- `wordpress.url_origin` (una cadena con URLs separadas por espacios, o una lista)

Un ejemplo mínimo:

```json
{
  "project": { "domain": "shop-demo.local" },
  "wordpress": {
    "url": "https://shop-demo.local",
    "url_origin": "https://shop-demo.example.com"
  }
}
```

El plugin claude-wp-builder crea este fichero. Puedes escribirlo a mano. Solo se usan las claves
de arriba.

**2. Vhosts de Apache.** El bot lee los ficheros `httpd-*.conf` de `VHOST_DIR` (por defecto
`/etc/httpd/conf/extra`). Lee `ServerName` y `ServerAlias`. Asocia un vhost a un sitio por su
`DocumentRoot` cuando está dentro de `SITES_ROOT`. Un vhost sin `DocumentRoot` (por ejemplo un
fichero de redirección) se asocia por el nombre del fichero: `httpd-shop-demo.conf` o
`httpd-shop-demo-redirect.conf` pertenecen al sitio `shop-demo`.

Debian y Ubuntu guardan los vhosts en `/etc/apache2/sites-enabled/` con otros nombres de fichero.
Define `VHOST_DIR` solo si tus ficheros siguen el patrón `httpd-*.conf`. Si no, apóyate en
`.wp-create.json`.

**nginx no se lee.** Con nginx, añade un `.wp-create.json` a cada sitio, o abre los trabajos a
mano con `/new <sitio>` (alias en español: `/nuevo <sitio>`).

Resultados de la detección:

- Coincide un sitio: el bot abre el trabajo.
- Coinciden varios, o ninguno: el bot muestra botones para elegir, o usas `/nuevo <sitio>`.
- El bot nunca crea un sitio y nunca adivina uno.

## 4. Crear el bot de Telegram y configurarlo

### Crea el bot con BotFather

1. En Telegram, abre un chat con `@BotFather`.
2. Envía `/newbot`.
3. Envía un nombre visible, por ejemplo `Issue Bot`.
4. Envía un nombre de usuario que acabe en `bot`, por ejemplo `mi_ayudante_issues_bot`.
5. BotFather responde con un token del estilo `123456789:AA...`. Cópialo. Trátalo como una
   contraseña.

### Descarga el código

```
git clone https://github.com/<propietario>/issue-bot.git
cd issue-bot
```

Usa la URL real del repositorio que has encontrado. El clon puede estar en cualquier carpeta. El
paso 5 escribe su ruta en el servicio.

### Escribe `.env`

```
cat > .env <<'EOF2'
TELEGRAM_TOKEN=123456789:AA...pega-tu-token
OWNER_ID=
CHAT_ID=
BOT_LANG=es
SITES_ROOT=/srv/http
EOF2
chmod 600 .env
```

Deja `OWNER_ID` y `CHAT_ID` vacíos. El bot los rellena cuando le escribes por primera vez (paso
5). `.env` está en `.gitignore`. No lo subas nunca.

### Referencia de `.env`

Todas las claves salvo `TELEGRAM_TOKEN` son opcionales. El bot lee `.env` solo al arrancar, así
que reinícialo tras cualquier cambio.

| Clave | Por defecto | Qué hace |
|---|---|---|
| `TELEGRAM_TOKEN` | ninguno (obligatorio) | Token del bot, de BotFather. Sin él el bot sale con código 1. |
| `OWNER_ID` | vacío | ID de Telegram de la única persona a la que obedece el bot. Vacío: el primer mensaje registra a su remitente. |
| `CHAT_ID` | vacío | El único chat en el que responde el bot. Vacío: el privado del dueño. Un mensaje en un grupo lo registra. |
| `BOT_LANG` | `es` | `es` o `en`. Idioma de los mensajes y botones del bot, de las respuestas de Claude y del informe HTML. |
| `SITES_ROOT` | `/srv/http` | Carpeta con una subcarpeta por sitio. |
| `AUDITS_ROOT` | `~/audits` | Dónde van las carpetas de trabajo y los informes. |
| `CLAUDE_BIN` | `claude` | Ejecutable de Claude Code. Pon la ruta completa si el servicio no lo encuentra. |
| `CHROMIUM_BIN` | `chromium` | Navegador que lanza Claude. Tiene que ser `chromium`, `chromium-browser`, `google-chrome` o `google-chrome-stable`. Cualquier otro valor hace que el bot salga al arrancar. |
| `BOT_SOCKET` | `<clon>/bot.sock` | Socket Unix del puente de permisos entre el bot y Claude. |
| `BATCH_IDLE_MS` | `120000` | Milisegundos sin mensajes nuevos tras los que se cierra el lote. Entero positivo. |
| `VHOST_DIR` | `/etc/httpd/conf/extra` | Carpeta de los vhosts de Apache (`httpd-*.conf`) que se usan para detectar el sitio. |

Los comandos funcionan en los dos idiomas. En español: `/nuevo <sitio>`, `/estado`, `/cancelar`,
`/cerrar`. En inglés: `/new <sitio>`, `/status`, `/cancel`, `/close`. `/plan` y `/start` son
iguales en ambos. Escribir `eso es todo` (o `that's all`) cierra el lote, igual que `/plan`.

## 5. Primer arranque

1. Instala las dependencias y pasa los tests:

   ```
   npm install
   npm test
   ```

   Tienen que pasar todos.

2. Instala y arranca el servicio:

   ```
   bin/install-service.sh
   ```

   El script escribe `~/.config/systemd/user/issue-bot.service` a partir de
   `systemd/issue-bot.service.in`, con la ruta real de tu clon. Después ejecuta
   `systemctl --user daemon-reload` y `systemctl --user enable --now issue-bot`. Con
   `bin/install-service.sh --no-start` solo escribe la unidad, sin arrancarla.

3. Regístrate como dueño. **Hazlo enseguida.** Mientras `OWNER_ID` esté vacío, la primera persona
   que escriba al bot se convierte en su dueña. Abre tu bot en Telegram y envía `/start`. El bot
   responde con el dueño y el chat que ha registrado y los guarda en `.env`.

4. Mira los logs:

   ```
   systemctl --user status issue-bot
   journalctl --user -u issue-bot -f
   ```

Si mueves el clon a otra carpeta, vuelve a ejecutar `bin/install-service.sh`.

## 6. Tu primer trabajo

Esta es una sesión de ejemplo con un sitio ficticio, `shop-demo`, servido en `shop-demo.local`.
La carpeta `SITES_ROOT/shop-demo` existe. Las líneas que empiezan por `Tú` son tuyas. Las que
empiezan por `Bot` son las respuestas del bot. El texto exacto puede variar un poco en tu
versión.

```
Tú (reenviado de la QA, con una captura):
    El botón «Añadir al carrito» de https://shop-demo.local/product/mug/
    sale gris en móvil. Debería ser texto blanco sobre fondo azul.
    [foto]

Tú (reenviado de la QA):
    Los enlaces del pie se solapan a 375 px de ancho en
    https://shop-demo.local/contact/

Bot:
    Trabajo abierto en shop-demo (detectado por shop-demo.local).
    Carpeta: /home/tu-usuario/audits/shop-demo/results/qa-2026-10-15
    Llevo 3 elementos. Sigue reenviando; cierro el lote con /plan o tras
    2 min sin mensajes.

Tú:
    eso es todo

Bot:
    Analizando…
```

Claude lee las capturas y el código. En esta fase no edita nada. Después:

```
Bot:
    1. Color del texto del botón «Añadir al carrito» en móvil
    Causa: .btn--cart fija el color con una regla más específica dentro
    de la media query móvil.
    Arreglo: mover el color a la regla base y quitar la anulación.
    Archivos: wp-content/themes/shop/assets/css/styles.css
    Medido: color rgb(120, 120, 120), 44x48 px a 375 px.
    Propuesto: color #fff.

    2. Enlaces del pie solapados a 375 px
    ...
    [ Aprobar plan ]
```

Puedes escribir en el chat para cambiar el plan. Claude responde con un plan nuevo y un botón
nuevo. Cuando el plan esté bien:

```
Tú:
    [pulsas Aprobar plan]

Bot:
    Implementando…
```

Mientras trabaja, Claude puede necesitar una orden que ninguna lista cubre. Recibes un mensaje:

```
Bot:
    Permiso: Bash: wp post list --post_type=product --format=ids
    [ Permitir ] [ Denegar ]
    [ Permitir «wp post list» en este trabajo ]
```

- **Permitir** deja pasar esta petición.
- **Denegar** la rechaza. Claude sigue sin ella.
- **Permitir … en este trabajo** recuerda la orden hasta que se cierra el trabajo. Solo se ofrece
  para órdenes sueltas, nunca para `chromium`, `wp eval`, `wp shell`, `wp db` ni `--exec`.

El bot edita el mensaje para mostrar lo que elegiste. Algunas acciones se deniegan siempre (por
ejemplo `git commit`) y para ellas no hay botón.

```
Tú:
    [pulsas Permitir «wp post list» en este trabajo]

Bot:
    Permiso: Bash: wp post list --post_type=product --format=ids
    → Permitido en este trabajo: wp post list
```

Cuando Claude termina, el bot envía el fichero del informe y un resumen:

```
Bot:
    Hecho. Los dos issues están corregidos. Los cambios están sin commitear en el tema.
    [fichero] informe-shop-demo-2026-10-15.html

Bot:
    1. Color del texto del botón «Añadir al carrito» en móvil — Corregido
    2. Enlaces del pie solapados a 375 px — Mitigado

Bot:
    Revisa el diff en el repo. Si hay correcciones, escríbelas; si no, /cerrar.
```

Abre el diff en el repo del sitio. Si algo está mal, escribe una corrección:

```
Tú:
    El pie mejora, pero los enlaces siguen tocándose a 360 px.

Bot:
    Analizando…

Bot:
    1. Enlaces del pie a 360 px
    Causa: ...
    [ Aprobar plan ]

Tú:
    [pulsas Aprobar plan]

Bot:
    Implementando…
    ...
    [fichero] informe-shop-demo-2026-10-15.html
```

Una corrección abre una ronda nueva del mismo trabajo, con su propio plan y su propia
aprobación. El informe nuevo sustituye al anterior en la carpeta del trabajo.

Cuando estés conforme, haz tú el commit de los cambios y cierra el trabajo:

```
Tú:
    /cerrar

Bot:
    Trabajo en shop-demo cerrado.
```

Útil en cualquier momento:

- `/estado` muestra el sitio, la fase, la ronda, los elementos pendientes y la carpeta del
  trabajo.
- `/cancelar` corta el turno de Claude en curso. Escribe `sigue`, para
  retomarlo.
- Si reenvías mensajes de otro sitio con un lote abierto, el bot pregunta si cambia a ese sitio
  o los añade al actual.
- Los reenvíos que llegan mientras Claude trabaja, o mientras un plan espera aprobación, se
  guardan para el siguiente lote.
- Tras el informe, un reenvío nuevo abre un lote de QA nuevo y un trabajo nuevo.

Si el repo del sitio tiene cambios sin commitear al abrir el trabajo, el bot los lista y pregunta
**Seguir** o **Cancelar**. El lote no se cierra hasta que respondas.

## 7. El informe

Cada trabajo tiene su carpeta:

```
AUDITS_ROOT/<sitio>/results/qa-AAAA-MM-DD/
```

Un segundo trabajo el mismo día recibe `-2`, `-3` y así sucesivamente. Dentro:

- `img/` guarda las capturas de la QA (`qa-NN`) y las que hace Claude (`NN-...png`).
- `informe.json` es lo que escribe Claude al final del turno de implementación. El nombre del
  fichero es fijo, sea cual sea `BOT_LANG`.
- `informe.html` es lo que el bot genera a partir del JSON. La copia que recibes lleva las
  imágenes incrustadas: es un único fichero que puedes abrir o reenviar en cualquier sitio.

El informe contiene:

- el contexto: dónde y cómo se probó, la rama y el estado de git;
- KPIs por estado: corregido, mitigado, no es de código, pendiente;
- una tarjeta por issue: el mensaje de la QA, las capturas de la QA como **Antes**, la causa, el
  arreglo, los ficheros cambiados, una tabla de mediciones (elemento, viewport, propiedad, antes,
  después) y las capturas **Después** de Claude, lado a lado;
- notas opcionales por issue.

Si Claude no escribe `informe.json`, el bot usa un `informe.md` como respaldo, y te avisa cuando
no encuentra ningún informe. Escribe `sigue`, y Claude lo genera.

## 8. Usarlo en un grupo de Telegram

El bot puede trabajar en un grupo en vez de en un chat privado.

1. En BotFather, envía `/setprivacy`, elige tu bot y pulsa **Disable**. Si no, en un grupo el bot
   solo recibe comandos, no textos sueltos ni capturas.
2. Quita el bot del grupo y vuelve a añadirlo, para que el cambio surta efecto.
3. Para el bot, o asegúrate de que `OWNER_ID` y `CHAT_ID` están vacíos, y escribe en el grupo. El
   primer mensaje que el bot reciba ahí registra a su remitente como dueño y al grupo como único
   chat. A partir de ahí solo atiende al dueño, y solo en ese grupo.
4. Todas las personas del grupo pueden leer lo que el bot publique, planes e informes incluidos.
5. Los reenvíos del dueño se aceptan, venga de quien venga el mensaje original. Los reenvíos de
   otras personas se ignoran.

Si ya te registraste en un chat privado y quieres pasar a un grupo, edita `.env`, vacía
`OWNER_ID` y `CHAT_ID`, ejecuta `systemctl --user restart issue-bot` y escribe en el grupo.

## 9. Actualizar

```
cd issue-bot
git pull --ff-only
npm install
systemctl --user restart issue-bot
```

Reiniciar con un turno en marcha corta ese turno. El trabajo se conserva en `state.json`;
escribe `sigue` para retomarlo.

Si tu clon sigue a `main` y no tiene cambios locales, `npm run deploy` actualiza con más
cuidado. Comprueba que el clon está en `main` y limpio, trae `origin/main`, pasa los tests sobre
él en un worktree temporal y espera a que el bot acabe su turno en curso antes de avanzar el clon
con fast-forward y reiniciarlo. Si algo falla con el bot parado, vuelve al commit anterior y
arranca el bot igualmente. Necesita el servicio instalado antes. El bot avisa del commit nuevo
por Telegram.

Vuelve a ejecutar `bin/install-service.sh` cuando cambie `systemd/issue-bot.service.in` o cuando
muevas el clon. Sobrescribe el fichero de la unidad, así que no edites a mano la copia
instalada.

## 10. Problemas frecuentes

Empieza por los logs:

```
journalctl --user -u issue-bot -n 100 --no-pager
```

**El bot no responde.**
- El servicio no está en marcha: `systemctl --user status issue-bot`.
- Otra persona u otro chat se registró antes. Revisa `OWNER_ID` y `CHAT_ID` en `.env`. El bot
  ignora sin avisar a cualquier otro usuario y chat. Corrige los valores y reinicia.
- En un grupo, el modo de privacidad está activo. Mira el paso 8.
- El token es incorrecto o está revocado. El log muestra un error 401. Corrige
  `TELEGRAM_TOKEN`.

**Código de salida 1 o 70.**
- El código 1 es un error de configuración: falta `TELEGRAM_TOKEN`, `CHROMIUM_BIN` no es válido, o
  no hay `node`. systemd no lo reintenta. Lee la línea del log, corrige `.env` y ejecuta
  `systemctl --user restart issue-bot`.
- El código 70 es un fallo inesperado. systemd reinicia el bot con una espera creciente, de 10 s
  a 5 min.

**Dos procesos con el mismo token.** Si lanzaste `node src/bot.js` a mano con el servicio activo,
se pisan los updates de Telegram. Para el manual. Usa solo el servicio.

**«No tengo ese sitio» o el bot pregunta de qué sitio es.**
- Comprueba que `SITES_ROOT/<sitio>` existe y tiene un `.wp-create.json` con el host (sección 3).
- Con Apache, comprueba que `VHOST_DIR` contiene ficheros `httpd-*.conf` y que el `DocumentRoot`
  está dentro de `SITES_ROOT`.
- Con nginx, o con cualquier otra cosa, usa `/nuevo <sitio>`.
- El índice se reconstruye en cada detección. No hace falta reiniciar.

**`claude` no tiene sesión para el usuario del servicio.** El servicio corre con tu usuario, pero
no lee el perfil de tu shell. Ejecuta `claude login` con ese usuario. Si el bot no encuentra el
binario, pon en `CLAUDE_BIN` la ruta completa (`command -v claude`). El `PATH` de la unidad es
`/usr/local/bin:/usr/bin`, y `bin/start.sh` añade `~/.local/bin` y la carpeta de node.

**El sandbox falla o falta `bwrap`.** El bot lanza Claude con un sandbox que tiene que estar
disponible. Instala bubblewrap (sección 2) y prueba `bwrap --version`. Algunas distribuciones
restringen los espacios de nombres de usuario sin privilegios, que bubblewrap necesita (Ubuntu
24.04 y posteriores lo hacen con AppArmor). Si `bwrap --version` funciona pero el sandbox sigue
fallando, mira en la documentación de tu distribución cómo permitir que `bwrap` cree espacios de
nombres de usuario.

**No se encuentra Chromium, o falla.** Pon en `CHROMIUM_BIN` un nombre que exista en tu `PATH` y
esté en la lista permitida: `chromium`, `chromium-browser`, `google-chrome`,
`google-chrome-stable`. No se acepta una ruta completa. En Ubuntu usa `chromium-browser`.

**Los botones de permiso dejan de funcionar.** Una petición de permiso espera 30 minutos. Pasado
ese tiempo se deniega y el mensaje dice «Denegado por tiempo». Un turno se corta a los 45
minutos. Los dos límites están en `src/config.js` (`permissionTimeoutMs`, `turnTimeoutMs`).
Un reinicio también borra las peticiones pendientes y la memoria de «permitir en este
trabajo». Escribe `sigue`, y Claude vuelve a preguntar.

**El bot se niega a arrancar el turno: `disableAllHooks` o `sandbox`.** El bot aplica su política
con un hook y define él mismo el sandbox. Si los settings del sitio, los del usuario o los
gestionados tienen `disableAllHooks` o cualquier clave `sandbox`, el bot no lanza a Claude.
Quita esa configuración (revisa `.claude/settings.json` y `.claude/settings.local.json` del
sitio, y `~/.claude/settings.json`) y escribe `sigue`.

**Falta una imagen en el informe.** El bot lista las imágenes que no encontró después del
informe. Claude tiene que guardarlas en la carpeta `img/` del trabajo. Escribe una corrección
pidiéndoselas.

## 11. Seguridad y desinstalación

Lee las secciones **Seguridad** y **Permisos** del [README](../README.es.md#seguridad). En
resumen:

- El bot da acceso a los ficheros de tus sitios desde Telegram. Úsalo solo sobre copias locales.
- Solo obedece al dueño, en un chat.
- El token es la llave. Deja `.env` con permisos 600 y fuera de git.
- Claude no puede hacer commit ni push, y los comandos de shell corren en un sandbox sin red.

### Desinstalar

```
systemctl --user disable --now issue-bot
rm ~/.config/systemd/user/issue-bot.service
systemctl --user daemon-reload
```

Después borra la carpeta del clon. Las carpetas de trabajo y los informes se quedan en
`AUDITS_ROOT`. Bórralos si ya no los necesitas. Si no usas otros servicios de usuario, también
puedes ejecutar `loginctl disable-linger "$USER"`. En BotFather, envía `/revoke` o `/deletebot`
para retirar el token.
