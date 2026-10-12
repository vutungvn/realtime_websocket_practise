// Gia lap duong di thuc te cua man hinh kho:
//
//   man hinh ──(mang noi bo kho: cut/restore)──▶ BO CAN BANG TAI (idle 60s) ──▶ server
//
// - Idle timeout: ket noi khong co byte nao di qua (ca 2 chieu) trong idleTimeoutMs -> LB dong.
//   Giong AWS ALB / nginx proxy_read_timeout: SSE im lang ban dem se bi cat neu khong co nhip tim.
// - cut(): mang kho rot. Ket noi dang mo bi TREO (goi tin bi giu, khong FIN/RST), ket noi moi bi tu choi ngay.
// - restore(): mang hoi phuc, goi tin bi giu duoc chuyen tiep (nhu TCP gui lai).
import net from "net";
import { log } from "../log";

interface Pipe {
  no: number;
  client: net.Socket;
  upstream: net.Socket;
  held: { up: Buffer[]; down: Buffer[] };
  idle?: NodeJS.Timeout;
  closedWhileDown: boolean;
}

export class LoadBalancerSim {
  private server?: net.Server;
  private readonly pipes = new Set<Pipe>();
  private down = false;
  private nextNo = 0;
  readonly stats = { connections: 0, refused: 0, idleKills: 0, bytesDown: 0, bytesUp: 0 };

  constructor(
    private readonly listenPort: number,
    private readonly target: { host: string; port: number },
    private readonly idleTimeoutMs: number,
    private readonly say: (m: string) => void = (m) => log("LB", m),
  ) {}

  async start() {
    this.server = net.createServer((c) => this.onClient(c));
    await new Promise<void>((ok) => this.server!.listen(this.listenPort, "0.0.0.0", ok));
    return (this.server.address() as net.AddressInfo).port;
  }

  get openConnections() {
    return this.pipes.size;
  }

  cut() {
    this.down = true;
    this.say(`📵 MANG KHO ROT: ${this.pipes.size} ket noi bi treo, ket noi moi bi tu choi`);
  }

  restore() {
    this.down = false;
    for (const p of [...this.pipes]) {
      p.held.up.splice(0).forEach((b) => this.forward(p, b, "up"));
      p.held.down.splice(0).forEach((b) => this.forward(p, b, "down"));
      if (p.closedWhileDown) this.kill(p);
    }
    this.say("📶 MANG KHO HOI PHUC");
  }

  /** Cat ngang moi ket noi (RST): nhu server khoi dong lai / LB chuyen node. */
  dropAll() {
    const n = this.pipes.size;
    [...this.pipes].forEach((p) => {
      clearTimeout(p.idle);
      this.pipes.delete(p);
      p.client.resetAndDestroy();
      p.upstream.resetAndDestroy();
    });
    this.say(`✂ cat ngang ${n} ket noi`);
  }

  async stop() {
    [...this.pipes].forEach((p) => this.kill(p));
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  private onClient(client: net.Socket) {
    client.on("error", () => {});
    if (this.down) {
      this.stats.refused++;
      client.resetAndDestroy();
      return;
    }
    this.stats.connections++;
    const upstream = net.connect(this.target.port, this.target.host);
    upstream.on("error", () => {});
    const p: Pipe = { no: ++this.nextNo, client, upstream, held: { up: [], down: [] }, closedWhileDown: false };
    this.pipes.add(p);
    this.armIdle(p);

    client.on("data", (b) => (this.down ? p.held.up.push(b) : this.forward(p, b, "up")));
    upstream.on("data", (b) => (this.down ? p.held.down.push(b) : this.forward(p, b, "down")));
    const onClose = () => {
      if (!this.pipes.has(p)) return;
      if (this.down) p.closedWhileDown = true; // ben kia chua biet duoc
      else this.kill(p);
    };
    client.on("close", onClose);
    upstream.on("close", onClose);
  }

  private forward(p: Pipe, b: Buffer, dir: "up" | "down") {
    const to = dir === "up" ? p.upstream : p.client;
    if (to.destroyed) return;
    to.write(b);
    if (dir === "up") this.stats.bytesUp += b.length;
    else this.stats.bytesDown += b.length;
    this.armIdle(p); // co byte di qua -> dong ho idle chay lai tu dau
  }

  private armIdle(p: Pipe) {
    clearTimeout(p.idle);
    p.idle = setTimeout(() => {
      this.stats.idleKills++;
      this.say(`⏱ ket noi #${p.no} im lang ${this.idleTimeoutMs / 1000}s -> LB DONG KET NOI`);
      if (this.down) p.closedWhileDown = true; // FIN bi ket trong mang rot, toi khi hoi phuc moi toi man hinh
      else this.kill(p);
    }, this.idleTimeoutMs);
  }

  private kill(p: Pipe) {
    clearTimeout(p.idle);
    this.pipes.delete(p);
    p.client.destroy();
    p.upstream.destroy();
  }
}
