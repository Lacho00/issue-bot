# issue-bot

## Despliegue

El bot corre como servicio systemd de usuario (`issue-bot`) desde este clon, en `main`.
No hay despliegue automático: lo lanza la sesión de Claude.

- Tras fusionar una PR o hacer push a `main`, ejecuta `npm run deploy` en `/srv/http/issue-bot`.
  El script pasa los tests sobre `origin/main`, avanza `main` y pide al bot que se reinicie
  cuando termine el turno en curso. Al arrancar, el bot avisa por Telegram con el commit.
- Si `npm run deploy` falla, informa del error y no reinicies el bot a mano.
- El clon se queda siempre en `main` y sin cambios: el servicio ejecuta este árbol. Trabaja
  en un worktree (`git worktree add ../issue-bot-<tema> -b <rama> main`).
- No arranques `node src/bot.js` a mano con el servicio activo: dos procesos con el mismo token
  se pisan.
