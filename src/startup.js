// Arranque sin bloquear en la red: ni los avisos de Telegram ni getMe pueden retrasar bot.ready.

// Lanza fn() sin esperarla. Un fallo se registra y no sale como unhandledRejection.
export function fireAndForget(fn, label, log = console.error) {
  return Promise.resolve()
    .then(fn)
    .catch((err) => log(`${label}: ${err?.message ?? err}`));
}

// Ejecuta los avisos uno tras otro (conservan el orden) sin que un fallo corte los siguientes.
export function sendNotices(notices, log = console.error) {
  return notices.reduce(
    (chain, { label, send }) => chain.then(() => fireAndForget(send, label, log)),
    Promise.resolve(),
  );
}

// Reintenta init() con espera creciente hasta que funcione o shouldStop() lo corte.
// Devuelve true si init() llegó a funcionar.
export async function initWithRetry(init, { sleep, log = console.error, shouldStop = () => false, baseMs = 2000, maxMs = 30000 } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; !shouldStop(); attempt++) {
    try {
      await init();
      return true;
    } catch (err) {
      const delay = Math.min(baseMs * 2 ** attempt, maxMs);
      log(`getMe falló (${err?.message ?? err}); reintento en ${delay / 1000} s`);
      await wait(delay);
    }
  }
  return false;
}
