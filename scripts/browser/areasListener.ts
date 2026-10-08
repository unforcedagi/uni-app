import dgram from 'node:dgram';
import http from 'node:http';
import type { Ports } from './areasFixture';

/** A local "attacker": an HTTP server and a UDP socket (the TURN port). Any hit means the sandbox leaked. */
export async function startListener() {
  const urls: string[] = [];
  const datagrams: string[] = [];
  const server = http.createServer((req, res) => { urls.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); res.end('<p>remote</p>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m) => datagrams.push(m.toString('latin1')));
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  const ports: Ports = { http: (server.address() as { port: number }).port, udp: udp.address().port };
  return {
    ports, urls, datagrams,
    async close() { await new Promise<void>((r) => server.close(() => r())); udp.close(); },
  };
}
