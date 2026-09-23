import { createServer, connect, type Socket, type AddressInfo } from 'node:net';

/** Local TCP fault boundary; never stops or reconfigures the shared Redis. */
export async function recoveryRedisTransport(upstreamUrl: string) {
  const upstream = new URL(upstreamUrl);
  if (!['localhost', '127.0.0.1'].includes(upstream.hostname))
    throw new Error('test Redis must be local');
  const sockets = new Set<Socket>();
  let available = false;
  let dropReplies = false;
  let accepted = 0;
  const server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (!available) {
      socket.resume(); // accept TCP and silently swallow RESP (not ECONNREFUSED)
      return;
    }
    const remote = connect({ host: upstream.hostname, port: Number(upstream.port || 6379) });
    remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
    socket.pipe(remote);
    remote.on('data', (chunk) => {
      if (!dropReplies) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(upstreamUrl);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.toString(),
    get sockets() {
      return sockets.size;
    },
    get accepted() {
      return accepted;
    },
    recover() {
      available = true;
      dropReplies = false;
    },
    loseReplies() {
      dropReplies = true;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
