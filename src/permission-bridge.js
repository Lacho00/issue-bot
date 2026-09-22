import net from 'node:net';
import { rmSync, chmodSync } from 'node:fs';

export function startBridge(socketPath, handler) {
  rmSync(socketPath, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        Promise.resolve()
          .then(() => handler(req))
          .catch((e) => ({ behavior: 'deny', message: `Error del bot: ${e.message}` }))
          .then((res) => { if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`); });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}

export function requestPermission(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
  });
}
