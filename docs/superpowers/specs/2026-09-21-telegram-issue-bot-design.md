# Bot de Telegram para resolver issues de sitios — diseño

Fecha: 2026-09-21
Estado: aprobado en conversación, pendiente de revisión escrita

## Objetivo

Recibir issues de sitios web por Telegram (texto y capturas), analizarlos con Claude Code en
la carpeta local del sitio, acordar un plan por chat, aplicar el arreglo en local y devolver
un informe HTML autocontenido con el antes y el después de cada issue.

## Alcance

Dentro:

- Un único usuario autorizado (el dueño). Chat privado con el bot.
- Un trabajo abierto a la vez, siempre sobre un solo sitio de `/srv/http/<sitio>`.
- Fix local, sin commit, en la rama activa del repo del sitio.
- Informe `.html` con imágenes embebidas, enviado como documento de Telegram.

Fuera:

- Commits, push, PR y deploy a staging o producción.
- Varios usuarios o varios trabajos en paralelo.
- Lectura de issues desde Redmine, GitHub u otras fuentes.
- Publicación del informe como artifact o en cualquier servicio externo.

## Decisiones tomadas

| Tema | Decisión |
|------|----------|
| Canal | Bot propio que despacha trabajos (no el plugin de channels de Claude Code) |
| Usuarios | Solo el dueño; cualquier otro remitente se ignora sin respuesta |
| Entrada | Texto y capturas de pantalla |
| Identificación del sitio | El dueño la da con `/nuevo <sitio>`; si falta, el bot pregunta |
| Delimitación del trabajo | Sesión explícita: `/nuevo` abre, `/cerrar` termina |
| Autonomía | El bot manda un plan y se discute antes de tocar código |
| Resultado | Fix local y informe HTML de antes y después |
| Git | Rama activa, cambios sin commitear; aviso si el árbol ya estaba sucio |
| Permisos | Lista blanca acotada; el resto se pide con botones Permitir/Denegar |
| Facturación | Suscripción actual: el bot lanza el binario `claude` ya autenticado |
| Formato de entrega | Archivo `.html` adjunto, imágenes en base64 |
| Stack | Node + grammY |

## 1. Arquitectura

```
Telegram (dueño)  <->  bot (proceso Node, servicio systemd --user)
                         ├─ estado: trabajo abierto {sitio, session_id, fase, carpeta}
                         ├─ lanza: claude -p --resume <id> --output-format stream-json
                         │         cwd = /srv/http/<sitio>
                         │         --settings <lista blanca>
                         │         --permission-prompt-tool mcp__bot__aprobar
                         └─ MCP "bot" (stdio) <-> socket local <-> bot <-> botones
```

- **Repo:** `/srv/http/issue-bot`, git local sin remote.
- **Autorización:** solo el user ID guardado en `.env` (`OWNER_ID`). Los mensajes de otros
  remitentes y los mensajes reenviados se ignoran sin respuesta.
- **Registro inicial del dueño:** si `OWNER_ID` está vacío, el primer mensaje privado que
  recibe el bot fija ese user ID en `.env` y el bot lo confirma. A partir de ahí no acepta a
  nadie más. El registro solo ocurre con `OWNER_ID` vacío y queda escrito en el log.
- **Secretos:** `TELEGRAM_TOKEN` y `OWNER_ID` en `.env`, que está en `.gitignore`.
- **Resolución del sitio:** `/nuevo <sitio>` exige que exista `/srv/http/<sitio>`. Si no
  existe, el bot responde con los nombres de carpeta más parecidos.
- **Carpeta del trabajo:** `/home/lacho/audits/<sitio>/results/qa-<AAAA-MM-DD>/`. Si ya
  existe una del mismo día, se añade sufijo `-2`, `-3`, etc.
- **Capturas recibidas:** se guardan como `img/qa-NN.png` en la carpeta del trabajo y se pasan
  a Claude por ruta. Son el «Antes» del informe.
- **Concurrencia:** un turno de Claude a la vez. Los mensajes que llegan mientras Claude
  trabaja se encolan y entran juntos en el turno siguiente.
- **Servicio:** unidad `systemd --user` con reinicio automático.
- **Persistencia:** `state.json` con sitio, `session_id`, fase, carpeta y cola pendiente.

## 2. Flujo de un trabajo

1. **Recogida.** Tras `/nuevo <sitio>`, el bot acumula textos y capturas. No llama a Claude.
2. **Plan (solo lectura).** Con `/plan` o «eso es todo», el bot manda el lote a Claude con
   `--permission-mode plan`. Claude puede leer, consultar el grafo de codebase-memory, abrir el
   sitio en el navegador y medir, pero no editar. Devuelve un plan numerado: por issue, causa
   probable, arreglo propuesto y archivos afectados. Los cambios visuales incluyen los valores
   medidos. Los issues que no son de código se marcan como tales.
3. **Discusión.** Los mensajes siguientes van a la misma sesión, todavía en modo plan. Cada
   versión del plan lleva un botón **Aprobar plan**.
4. **Implementación.** Al aprobar, la sesión se retoma con la lista blanca y los botones de
   permiso. Claude aplica solo lo aprobado y ejecuta el build del tema si existe. En cambios
   visuales mide antes y después con `getComputedStyle` y `getBoundingClientRect`, en
   escritorio y móvil. Si los valores no coinciden con lo esperado, se detiene y pregunta.
5. **Informe.** Claude escribe `informe.md` e `informe.html` en la carpeta del trabajo, con la
   estructura del informe de QA de referencia: tabla resumen con estado por issue y, por
   issue, Antes, Causa, Arreglo y Después. El bot embebe las imágenes en base64, envía el
   `.html` como documento y un resumen corto con la tabla de estados.
6. **Cierre.** `/cerrar` termina el trabajo y descarta la sesión. Si antes de cerrar llegan
   correcciones, el trabajo vuelve a la fase 2.

Instrucciones a Claude: el bot añade con `--append-system-prompt` las reglas del flujo (fase
actual, formato del plan, formato del informe, ruta de la carpeta del trabajo). El
`CLAUDE.md` global y el del proyecto se cargan como en cualquier sesión.

Mensajes de progreso: un solo mensaje de estado que se edita («leyendo tema…», «midiendo
#4…»). Los mensajes de más de 4096 caracteres se dividen.

Comandos: `/nuevo <sitio>`, `/plan`, `/estado`, `/cancelar` (corta el turno en curso),
`/cerrar`.

## 3. Permisos

Sin preguntar:

- Leer cualquier archivo.
- Editar y crear archivos dentro de `/srv/http/<sitio>/` y de la carpeta del trabajo.
- Ejecutar: `npm run build`, WP-CLI de solo lectura (`wp option get`, `wp post list`,
  `wp theme list` y similares), Playwright o chromium para capturas y mediciones,
  `git status`, `git diff`, `git log`.

Con botón Permitir/Denegar en Telegram: todo lo demás. Por ejemplo, WP-CLI que escribe en la
base de datos, `npm install`, borrado de archivos o cualquier escritura fuera de las dos
carpetas.

Nunca: `git commit`, `git push`, instalación de Playwright o de sus navegadores (regla
global de la máquina).

## 4. Errores y límites

- **Permiso sin respuesta:** se deniega a los 30 minutos.
- **Límite de uso de la suscripción:** el bot avisa, con la hora de reinicio si la conoce. No
  reintenta solo.
- **Turno colgado o crash de `claude`:** timeout de 45 minutos por turno. El bot mata el
  proceso, avisa y deja la sesión disponible para retomarla.
- **Reinicio del bot o de la máquina:** al arrancar lee `state.json` y avisa del trabajo
  abierto y su fase. No relanza turnos solo.
- **Repo sucio al abrir:** muestra `git status --short` y pregunta Seguir o Cancelar.
- **Informe ausente:** si Claude termina la fase 5 sin `informe.html`, el bot lo dice y no
  envía nada.
- **Capturas como archivo:** se guardan sin comprimir; el informe las escala por CSS.
- **Contexto:** si un trabajo supera unos 200k tokens, el bot sugiere cerrarlo y abrir otro.

## 5. Pruebas

Automáticas con `node --test`, sin Telegram ni Claude reales:

- Autorización: remitente ajeno ignorado, mensaje reenviado ignorado, registro inicial solo
  con `OWNER_ID` vacío.
- Máquina de estados: recorrido completo y transiciones inválidas (`/plan` sin trabajo,
  segundo `/nuevo` con uno abierto, Aprobar fuera de la fase de plan).
- Permisos: edición fuera de la carpeta del sitio pide botón, comando en lista blanca pasa,
  timeout deniega.
- Informe: el `.html` final no contiene referencias `img/` sin embeber.
- Runner: un binario `claude` falso que emite `stream-json` grabado, para probar parseo,
  timeout y crash.

Prueba real: un trabajo completo sobre `tienda-demo` con un issue trivial, validado por el
dueño desde el móvil.

## Pasos manuales del dueño

1. Crear el bot en @BotFather y entregar el token.
2. Escribir al bot para que registre el `OWNER_ID`.
