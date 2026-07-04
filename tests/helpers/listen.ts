import { createServer } from 'node:net';

let cachedLoopbackSkipReason: Promise<string | undefined> | undefined;

export function loopbackListenSkipReason(): Promise<string | undefined> {
  cachedLoopbackSkipReason ??= probeLoopbackListen();
  return cachedLoopbackSkipReason;
}

function probeLoopbackListen(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        resolve(`loopback listen unavailable in this environment (${err.code})`);
        return;
      }
      resolve(undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(undefined));
    });
  });
}
