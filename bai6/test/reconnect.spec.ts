// Kiem thu end-to-end: server NestJS that + mang gia lap (ChaosProxy) + app tai xe that.
import { INestApplication } from "@nestjs/common";
import { io as connectIo, ManagerOptions } from "socket.io-client";
import { sleep } from "../src/common/log";
import { createDriverApp, DriverApp, RECONNECT_OPTIONS } from "../src/client/driver-client";
import { startServer } from "../src/server/bootstrap";
import { serverConfig } from "../src/server/config";
import { DriverPresence } from "../src/server/presence.service";
import { ChaosProxy } from "../src/tools/chaos-proxy";

// Cau hinh client thu nho (cung hinh dang voi RECONNECT_OPTIONS, chi nhanh hon).
const FAST: Partial<ManagerOptions> = {
  reconnectionDelay: 100,
  reconnectionDelayMax: 800,
  randomizationFactor: 0,
  timeout: 500,
};

let app: INestApplication;
let base: string;
let proxy: ChaosProxy;
let proxyUrl: string;
const apps: DriverApp[] = [];

beforeEach(async () => {
  const server = await startServer(0);
  app = server.app;
  base = `http://127.0.0.1:${server.port}`;
  proxy = new ChaosProxy(0, { host: "127.0.0.1", port: server.port }, () => {});
  proxyUrl = `http://127.0.0.1:${await proxy.start()}`;
});

afterEach(async () => {
  apps.splice(0).forEach((a) => a.close());
  await proxy.stop();
  await app.close();
});

function openDriver(driverId: string, zones: string[], extra: Partial<ManagerOptions> = {}, slowRetryMs = 500) {
  const a = createDriverApp({
    serverUrl: proxyUrl,
    token: `tok_${driverId}`,
    zones,
    socketOptions: { ...FAST, ...extra },
    slowRetryMs,
    silent: true,
  });
  apps.push(a);
  return a;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  throw new Error(`het ${timeoutMs}ms ma dieu kien chua dung`);
}

async function presence(driverId: string) {
  const list = (await (await fetch(`${base}/drivers`)).json()) as (DriverPresence & { rooms: string[] })[];
  return list.find((d) => d.driverId === driverId);
}

async function createOrder(zone: string) {
  const res = await fetch(`${base}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ zone }),
  });
  return ((await res.json()) as { order: { orderId: string } }).order.orderId;
}

const online = (a: DriverApp) => a.state.kind === "online";

// ---------------------------------------------------------------------------
describe("cau hinh client (cho khuyet 1, 2)", () => {
  it("bat reconnect, co gioi han so lan, backoff gian dan co tran va co jitter", () => {
    expect(RECONNECT_OPTIONS.reconnection).toBe(true);
    expect(Number.isFinite(RECONNECT_OPTIONS.reconnectionAttempts)).toBe(true);
    expect(RECONNECT_OPTIONS.reconnectionDelayMax).toBeGreaterThan(RECONNECT_OPTIONS.reconnectionDelay);
    expect(RECONNECT_OPTIONS.randomizationFactor).toBeGreaterThan(0);
  });
});

describe("mat mang roi co lai", () => {
  it("TC1: tu noi lai, van o dung cac room cu, nhan don moi + duoc bu don bi lo", async () => {
    const a = openDriver("driver-01", ["cau-giay", "dong-da"]);
    await waitFor(() => online(a));
    const roomsBefore = (await presence("driver-01"))!.rooms;
    const socketBefore = a.socket.id;

    proxy.cut();
    const missedId = await createOrder("cau-giay"); // phat luc tai xe dang trong ham
    await waitFor(() => a.state.kind === "reconnecting"); // app tu phat hien qua heartbeat
    proxy.restore();

    await waitFor(() => online(a) && a.socket.id !== socketBefore);
    expect((await presence("driver-01"))!.rooms).toEqual(roomsBefore);
    expect(roomsBefore).toEqual(["driver:driver-01", "zone:cau-giay", "zone:dong-da"]);
    expect(a.orders.map((o) => o.orderId)).toEqual([missedId]);

    const newId = await createOrder("dong-da");
    await waitFor(() => a.orders.length === 2);
    expect(a.orders[1].orderId).toBe(newId);
  });

  it("TC2: thoi gian cho giua cac lan thu GIAN DAN, dung o tran reconnectionDelayMax", async () => {
    const a = openDriver("driver-02", ["cau-giay"]);
    await waitFor(() => online(a));

    proxy.dropAll();
    proxy.cut(); // giu mat mang de app thu nhieu lan
    await waitFor(() => a.retryLog.length >= 6, 10_000);
    proxy.restore();

    const waits = a.retryLog.slice(0, 6).map((r) => r.waitedMs);
    // ky vong ~100, 200, 400, 800, 800, 800 (min * 2^n, tran 800)
    [100, 200, 400, 800, 800, 800].forEach((expected, i) => {
      expect(waits[i]).toBeGreaterThanOrEqual(expected * 0.8);
      expect(waits[i]).toBeLessThan(expected * 1.5 + 50);
    });
    await waitFor(() => online(a), 5_000);
  });

  it("TC3: het so lan thu -> khong spam, chuyen sang thu cham va tu noi lai khi co mang", async () => {
    const a = openDriver("driver-03", ["cau-giay"], { reconnectionAttempts: 3 }, 800);
    await waitFor(() => online(a));

    proxy.dropAll();
    proxy.cut();
    await waitFor(() => a.state.kind === "waiting-network", 5_000);
    const attemptsAtGiveUp = proxy.stats.attempts;
    await sleep(500);
    expect(proxy.stats.attempts).toBe(attemptsAtGiveUp); // dang cho, khong ban request

    proxy.restore();
    await waitFor(() => online(a), 5_000); // tai xe khong lam gi
  });
});

describe("server danh dau offline (cho khuyet 5)", () => {
  const detectMax = serverConfig.pingIntervalMs + serverConfig.pingTimeoutMs;

  it("TC4: tat han app trong vung mat song -> offline sau heartbeat + an han, khong som hon", async () => {
    const a = openDriver("driver-04", ["cau-giay"]);
    await waitFor(() => online(a));

    proxy.cut();
    a.close(); // goi tin bao dong bi ket lai -> server khong biet
    const killedAt = Date.now();
    await sleep(100);
    expect((await presence("driver-04"))!.status).toBe("online"); // server chua the biet

    await waitFor(async () => (await presence("driver-04"))!.status === "offline", detectMax + serverConfig.offlineGraceMs + 1_000);
    const elapsed = Date.now() - killedAt;
    expect(elapsed).toBeGreaterThanOrEqual(serverConfig.offlineGraceMs);
    expect(elapsed).toBeLessThanOrEqual(detectMax + serverConfig.offlineGraceMs + 300);
    expect((await presence("driver-04"))!.lastDisconnectReason).toBe("ping timeout");
  });

  it("TC5: rot mang ngan roi noi lai trong an han -> KHONG bi tinh offline", async () => {
    const a = openDriver("driver-05", ["cau-giay"]);
    await waitFor(() => online(a));

    proxy.dropAll(); // rot ngang, 2 ben biet ngay -> server: reconnecting
    await waitFor(async () => (await presence("driver-05"))!.status === "reconnecting", 1_000);
    await waitFor(() => online(a), 2_000);

    await sleep(serverConfig.offlineGraceMs + 200);
    expect((await presence("driver-05"))!.status).toBe("online");
  });
});

describe("bay du lieu: mang chap chon", () => {
  it("TC6: bat/tat 10 lan -> so lan thu co gioi han, khong nhan doi listener, don moi nhan dung 1 lan", async () => {
    const a = openDriver("driver-06", ["cau-giay"], { randomizationFactor: 0.5 });
    await waitFor(() => online(a));
    proxy.stats.attempts = 0;

    for (let i = 0; i < 10; i++) {
      proxy.dropAll();
      proxy.cut();
      await sleep(150);
      proxy.restore();
      await sleep(150);
    }
    await waitFor(() => online(a), 5_000);

    expect(proxy.stats.attempts).toBeLessThanOrEqual(30); // <= ~3 lan thu / lan chap chon
    expect(a.socket.listeners("order:new")).toHaveLength(1);
    expect((await presence("driver-06"))!.rooms).toEqual(["driver:driver-06", "zone:cau-giay"]);

    await createOrder("cau-giay");
    await sleep(300);
    expect(a.orders).toHaveLength(1);
  });

  it("TC7: server chan ket noi qua day (rate limit) va bao client thoi gian cho", async () => {
    const errors: { message: string; data?: { retryAfterMs: number } }[] = [];
    for (let i = 0; i < 21; i++) {
      const s = connectIo(base, { auth: { token: "tok_spammer" }, transports: ["websocket"], reconnection: false, forceNew: true });
      await new Promise<void>((done) => {
        s.once("connect", () => done());
        s.once("connect_error", (e: Error & { data?: { retryAfterMs: number } }) => (errors.push(e), done()));
      });
      s.disconnect();
    }
    expect(errors).toHaveLength(1); // lan thu 21 bi chan
    expect(errors[0].message).toBe("rate_limited");
    expect(errors[0].data!.retryAfterMs).toBeGreaterThan(0);
  });

  it("TC8: token sai -> bao tai xe dang nhap lai, KHONG tu thu lai", async () => {
    const a = createDriverApp({ serverUrl: proxyUrl, token: "token-gia", zones: [], socketOptions: FAST, silent: true });
    apps.push(a);
    await waitFor(() => a.state.kind === "rejected");
    const attempts = proxy.stats.attempts;
    await sleep(800);
    expect(proxy.stats.attempts).toBe(attempts);
  });
});
