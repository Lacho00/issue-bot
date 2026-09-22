# Flujo de reenvío de QA — diseño

Fecha: 2026-09-22. Amplía `2026-09-21-telegram-issue-bot-design.md`; donde contradiga a ese documento, manda este.

## Objetivo

El dueño reenvía al grupo de Telegram los mensajes que le manda la QA (textos, capturas, álbumes).
El bot detecta el sitio, agrupa el lote, propone un plan, lo implementa tras un solo botón y
devuelve un informe HTML con el resultado.

## Decisiones

- Autonomía: plan + un botón **Aprobar plan**. Tras aprobar, sin más botones salvo lo que no
  cubra ninguna lista de permisos.
- Sitio: detección por URL/dominio. `/nuevo <sitio>` se mantiene para forzarlo o cuando no se detecta.
- Lote: se cierra tras 2 min sin mensajes nuevos. `/plan` o «eso es todo» lo cierran ya.
- Permisos: se cargan los settings del usuario, del proyecto y locales del sitio, más los del bot.
  Los deny del bot ganan.
- El bot nunca crea sitios. Solo trabaja sobre carpetas existentes en `SITES_ROOT`.

## Flujo

1. El dueño reenvía mensajes. Se aceptan reenvíos cuyo `from.id` es el dueño y cuyo `chat.id` es el
   chat registrado; el autor original no importa. El resto de reglas de autorización no cambia.
2. Detección del sitio con el lote abierto:
   - Se extraen hosts de las URLs del texto, del caption y de las entidades `url` y `text_link`.
   - Un solo sitio coincide: se abre el trabajo y se avisa
     «Trabajo abierto en X (detectado por <host>)».
   - Varios o ninguno: botones con hasta 5 candidatos más «Otro» (pide `/nuevo <sitio>`).
   - Sin URLs en todo el lote al cerrarse: «¿De qué sitio es? Usa /nuevo <sitio>». El lote se conserva.
   - `/nuevo <sitio>` explícito siempre gana sobre la detección.
3. Lote: cada mensaje recibido en fase `collecting` reinicia un temporizador de 2 min
   (`BATCH_IDLE_MS`, por defecto 120 000). Al vencer, equivale a `/plan`. Las fotos de un álbum
   (`media_group_id`) llegan como updates separados y cada una reinicia el temporizador.
4. Plan: igual que hoy (fase `plan`, botón **Aprobar plan**, discusión por chat).
5. Implementación: `--setting-sources user,project,local`. El `CLAUDE.md` del sitio se carga solo,
   así que se quita del prompt la instrucción de leerlo.
6. Informe: Claude escribe `informe.md` en español; el bot genera `informe.html` con las imágenes
   embebidas y lo envía al chat, con la tabla resumen como mensaje.
7. Tras el informe (fase `reported`):
   - Texto escrito por el dueño (no reenviado): corrección, nueva ronda del mismo trabajo.
   - Mensaje reenviado: lote nuevo de QA. Se cierra el trabajo actual y se abre otro para el sitio
     detectado (misma regla del paso 2), con carpeta `qa-<fecha>-N` y sesión de Claude nueva.
8. Reenvíos que llegan mientras Claude trabaja se guardan en una cola de lote siguiente
   (`nextBatch`) y se procesan al terminar el turno según la fase resultante.

## Casos de conflicto

- Trabajo abierto de otro sitio en `collecting` y llega un reenvío que detecta el sitio Y:
  botones «Cambiar a Y» (cierra X, abre Y con los items del reenvío) / «Añadir a X».
- Trabajo abierto en `plan` o `implement` sin turno en curso y llega un reenvío: se guarda en
  `nextBatch` y se avisa «Guardado para el siguiente lote».
- La URL apunta a un host que no está en el índice: «No tengo ese sitio (<host>)» con candidatos
  por nombre parecido (reutiliza `resolveSite`).

## Componentes

Nuevos, puros y con tests:

- `src/site-index.js` — `buildSiteIndex({sitesRoot, vhostDir}) -> Map<host, siteName>`.
  Fuentes: `<sitio>/.wp-create.json` (`project.domain`, `wordpress.url`, `wordpress.url_origin`, que
  puede traer varias URLs separadas por espacios) y `vhostDir/httpd-*.conf` (`ServerName`,
  `ServerAlias`; se asocia al sitio cuyo `DocumentRoot` está bajo `sitesRoot/<sitio>`).
  Normaliza: minúsculas, sin `www.`, sin puerto. `vhostDir` por defecto `/etc/httpd/conf/extra`
  (`VHOST_DIR` en `.env`). Ficheros ilegibles o JSON inválido se saltan sin fallar.
  Se reconstruye al arrancar y en cada detección (barato).
- `src/detect.js` — `extractHosts(text, entities) -> string[]` y
  `matchSite(hosts, index) -> {kind: 'one', site, host} | {kind: 'many', sites} | {kind: 'none'}`.
- `src/batch.js` — `createBatchTimer(ms, onFire) -> {touch(), flush(), cancel(), pending}`.

Cambios:

- `src/auth.js` — los reenvíos del dueño en el chat registrado pasan a `allow`.
- `src/state.js` — items pendientes con `forwarded: boolean`; `job.round` (empieza en 1, +1 en cada
  corrección tras `reported`); `nextBatch: item[]` fuera del job, persistido en `state.json`.
- `src/runner.js` — `--setting-sources user,project,local`.
- `src/prompts.js` — quitar «lee el CLAUDE.md del sitio».
- `src/policy.js` — deny adicionales, porque los allow amplios del repo quedan activos:
  `Bash(git add:*)`, `Bash(git reset --hard:*)`, `Bash(git checkout -- :*)`, `Bash(git clean:*)`,
  `Bash(wp db drop:*)`, `Bash(wp db reset:*)`, `Bash(wp db import:*)`, y los mismos patrones en
  `decidePermission`. Se mantienen todos los deny actuales.
- `src/bot.js` — detección de sitio y botones de candidatos, temporizador de lote, regla
  reenvío/escrito en `reported`, `nextBatch`, conflictos de sitio.
- `src/config.js` — `batchIdleMs`, `vhostDir`.
- `README.md` — flujo de reenvío y nuevas claves de `.env`.

## Errores

- Índice vacío o sin coincidencias: se cae a `/nuevo <sitio>`; nunca se adivina un sitio.
- Si el clasificador de seguridad de Claude Code bloquea el cambio de `--setting-sources` durante la
  implementación, se para y se pide al dueño que lo apruebe o lo aplique.
- Los errores de entrega del informe y de descarga de capturas se tratan como hoy.

## Tests

- `site-index`: fixtures temporales con `.wp-create.json` y vhosts falsos; `www.`, puertos,
  `url_origin` con varias URLs, alias, JSON inválido.
- `detect`: texto suelto, entidades `url` y `text_link`, URLs dentro de frases en español, cero, uno
  y varios sitios.
- `batch`: rebote con `mock.timers`, `flush` manual, `cancel`.
- `auth`: reenvío del dueño en su chat → `allow`; reenvío de otro miembro → `ignore`.
- `state`: marca `forwarded`, `round`, `nextBatch` persistido.
- `policy`: los deny nuevos.
- `bot.js` sin tests unitarios; prueba en vivo con `bot-sandbox`, al que se le añade un
  `.wp-create.json` con un dominio de prueba.

## Fuera de alcance

Varios trabajos abiertos a la vez, commits automáticos, crear sitios, despliegue en servidor.
