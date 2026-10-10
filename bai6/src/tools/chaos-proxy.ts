// Proxy TCP gia lap mang di dong, dat giua app tai xe va server:
//
//   app tai xe ──▶ ChaosProxy (:4100) ──▶ server (:4000)
//
//   cut()      : "vao ham". Ket noi dang mo bi DUNG (goi tin bi giu lai, khong ai nhan duoc gi, khong co FIN/RST)
//                -> 2 ben chi phat hien bang heartbeat. Ket noi MOI bi tu choi ngay (nhu dien thoai khong co song).
//   restore()  : "ra khoi ham". Goi tin bi giu duoc chuyen tiep (nhu TCP gui lai), ket noi moi di qua binh thuong.
//   dropAll()  : cat ngang moi ket noi (RST) - nhu doi tram BTS / server restart: 2 ben biet ngay.
import net from "net";
import { log } from "../common/log";

interface Pipe {
  client: net.Socket;
  upstream: net.Socket;
  held: { toServer: Buffer[]; toClient: Buffer[] };
  /** Ben nao da dong trong luc mat mang -> se dong ben kia khi co mang lai */
  closedWhileDown: boolean;
}

export class ChaosProxy {
  private server?: net.Server;
  private readonly pipes = new Set<Pipe>();
  private down = false;
  readonly stats = { attempts: 0, refused: 0 };
  /** Thoi diem moi lan app thu mo ket noi TCP (de do "bao request"). */
  readonly attemptTimes: number[] = [];

  constructor(
    private readonly listenPort: number,
    private readonly target: { host: string; port: number },
    private readonly say: (msg: string) => void = (m) => log("NETWORK", m),
  ) {}

  async start(): Promise<number> {
    this.server = net.createServer((client) => this.onClient(client));
    await new Promise<void>((ok) => this.server!.listen(this.listenPort, "0.0.0.0", ok));
    return (this.server.address() as net.AddressInfo).port;
  }

  get isDown() {
    return this.down;
  }

  cut() {
    this.down = true;
    this.say(`📵 MAT MANG: ${this.pipes.size} ket noi dang mo bi treo, ket noi moi bi tu choi`);
  }

  restore() {
    this.down = false;
    let flushed = 0;
    for (const p of [...this.pipes]) {
      flushed += p.held.toServer.length + p.held.toClient.length;
      p.held.toServer.splice(0).forEach((b) => !p.upstream.destroyed && p.upstream.write(b));
      p.held.toClient.splice(0).forEach((b) => !p.client.destroyed && p.client.write(b));
      if (p.closedWhileDown) this.kill(p);
    }
    this.say(`📶 CO MANG LAI (chuyen tiep ${flushed} goi bi giu)`);
  }

  dropAll() {
    const n = this.pipes.size;
    for (const p of [...this.pipes]) {
      p.client.resetAndDestroy();
      p.upstream.resetAndDestroy();
      this.pipes.delete(p);
    }
    this.say(`✂️  cat ngang ${n} ket noi (RST)`);
  }

  async stop() {
    for (const p of [...this.pipes]) this.kill(p);
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  private onClient(client: net.Socket) {
    this.stats.attempts++;
    this.attemptTimes.push(Date.now());
    client.on("error", () => {});
    if (this.down) {
      this.stats.refused++;
      client.resetAndDestroy(); // khong co song -> that bai ngay
      return;
    }

    const upstream = net.connect(this.target.port, this.target.host);
    upstream.on("error", () => {});
    const pipe: Pipe = { client, upstream, held: { toServer: [], toClient: [] }, closedWhileDown: false };
    this.pipes.add(pipe);

    client.on("data", (b) => (this.down ? pipe.held.toServer.push(b) : upstream.write(b)));
    upstream.on("data", (b) => (this.down ? pipe.held.toClient.push(b) : client.write(b)));

    const onClose = () => {
      if (!this.pipes.has(pipe)) return;
      // Dang mat mang: ben kia KHONG duoc biet (giong dien thoai het pin trong ham).
      if (this.down) pipe.closedWhileDown = true;
      else this.kill(pipe);
    };
    client.on("close", onClose);
    upstream.on("close", onClose);
  }

  private kill(p: Pipe) {
    this.pipes.delete(p);
    p.client.destroy();
    p.upstream.destroy();
  }
}
