import { createWriteStream, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function splitMessage(text, max = 4096) {
  if (text.length <= max) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) { parts.push(current); current = ''; }
      for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) { parts.push(current); current = line; }
    else current = candidate;
  }
  if (current) parts.push(current);
  return parts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (status) => status === 429 || status >= 500;

// Descarga `url` en `dest`. Cada intento tiene su propio plazo, que cubre también la lectura
// del cuerpo: sin él, una conexión colgada deja el update parado para siempre. Reintenta los
// fallos de red, los plazos vencidos, 429 y 5xx; un 4xx no cambia al repetirlo. Si falla, no
// deja un fichero a medias. Los errores no llevan la URL, que incluye el token.
export async function downloadToFile(url, dest, { timeoutMs = 60_000, attempts = 3, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        lastError = new Error(`descarga ${res.status}`);
        await res.body?.cancel().catch(() => {});
        if (!retryable(res.status)) break;
      } else {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
        return dest;
      }
    } catch (e) {
      lastError = new Error(`descarga: ${e.name === 'TimeoutError' ? `sin respuesta en ${timeoutMs / 1000} s` : e.message}`);
    }
    rmSync(dest, { force: true });
    if (i < attempts) await sleep(retryDelayMs * i);
  }
  rmSync(dest, { force: true });
  throw lastError;
}
