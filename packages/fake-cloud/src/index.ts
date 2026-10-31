import { createServer, type Server } from "node:http";

export type FakeCloud = { url: string; close: () => Promise<void> };

/** Starts the fake cloud on `port` (0 = random). Endpoints are added in T0.4. */
export async function startFakeCloud(port = 0): Promise<FakeCloud> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
