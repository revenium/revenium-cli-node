import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

export interface ConnectProxy {
  url: string;
  tunnelledAuthorities: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}

export function createConnectProxy(): ConnectProxy {
  const tunnelledAuthorities: string[] = [];
  const openSockets = new Set<Socket>();
  let server: Server;
  let port = 0;

  function openTunnel(request: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const authority = request.url ?? "";
    tunnelledAuthorities.push(authority);
    const [host, rawPort] = authority.split(":");
    const upstream = connect(Number(rawPort), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    for (const socket of [clientSocket, upstream]) {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
  }

  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    tunnelledAuthorities,

    start() {
      server = createServer((_req, res) => {
        res.writeHead(405);
        res.end();
      });
      server.on("connect", openTunnel);

      return new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          port = typeof address === "object" && address ? address.port : 0;
          resolve();
        });
      });
    },

    stop() {
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },

    reset() {
      tunnelledAuthorities.length = 0;
    },
  };
}
