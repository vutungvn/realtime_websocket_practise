// Kiem thu nghiep vu end-to-end: server NestJS that + bo can bang tai gia lap + EventSource that
// (goi `eventsource` mo phong dung hanh vi trinh duyet) boc boi public/reliable-sse.js - CUNG file trinh duyet dung.
import { INestApplication } from "@nestjs/common";
import { EventSource } from "eventsource";
import { sleep } from "../src/log";
import { startServer } from "../src/server/bootstrap";
import { config, watchdogMs } from "../src/server/config";
import { LoadBalancerSim } from "../src/tools/lb-sim";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ReliableStream = require("../public/reliable-sse.js");

const LB_IDLE_MS = 1_000; // = 60s that, thu nho 60 lan

interface Received {
  type: string;
  data: any;
  at: number;
}

let app: INestApplication;
let port: number;
let base: string;
let lb: LoadBalancerSim;
let lbUrl: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  ({ app, port } = await startServer(0));
  base = `http://127.0.0.1:${port}`;
  lb = new LoadBalancerSim(0, { host: "127.0.0.1", port }, LB_IDLE_MS, () => {});
  lbUrl = `http://127.0.0.1:${await lb.start()}`;
});

afterEach(async () => {
  cleanups.splice(0).forEach((fn) => fn());
  await lb.stop();
  await app.close();
});

/** Man hinh kho dung ReliableStream (giai phap da chon). */
function screen(url = `${lbUrl}/stream`) {
  const events: Received[] = [];
  const statuses: string[] = [];
  const s = ReliableStream.create({
    url,
    EventSource,
    watchdogMs: watchdogMs(),
    retryMs: config.retryMs,
    onEvent: (type: string, data: unknown) => events.push({ type, data, at: Date.now() }),
    onStatus: (st: { state: string }) => statuses.push(st.state),
  });
  cleanups.push(() => s.close());
  const business = () => events.filter((e) => e.type !== "heartbeat");
  return { s, events, statuses, business, alerts: () => events.filter((e) => e.type === "stock-alert") };
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const stats = () => fetch(`${base}/api/stats`).then((r) => r.json());

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`het ${timeoutMs}ms ma dieu kien chua dung`);
}

// ===========================================================================
describe("nghiep vu co ban", () => {
  it("TC1: man hinh mo len nhan ngay SNAPSHOT trang thai hien tai", async () => {
    await post("/admin/order", { count: 3, amount: 100_000 });
    await post("/admin/stock", { sku: "SAC-20W", qty: 0 });
    const sc = screen();
    await waitFor(() => sc.events.some((e) => e.type === "snapshot"));
    const snap = sc.events[0].data;
    expect(snap.newOrders).toBe(3);
    expect(snap.revenue).toBe(300_000);
    expect(snap.alerts).toEqual([expect.objectContaining({ sku: "SAC-20W", level: "out" })]);
  });

  it("TC2: canh bao het hang toi man hinh trong vong 10 giay (thuc te: vai chuc ms)", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    const { alert } = await post("/admin/stock", { sku: "TN-BT01", qty: 0 });
    await waitFor(() => sc.alerts().length === 1);
    const latency = sc.alerts()[0].at - alert.createdAt;
    expect(latency).toBeLessThan(10_000);
    expect(latency).toBeLessThan(500);
  });

  it("TC3: so lieu duoc GOP (100 don/khoanh khac -> vai su kien), canh bao thi KHONG gop", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    for (let i = 0; i < 10; i++) await post("/admin/order", { count: 10, amount: 10_000 });
    await post("/admin/stock", { sku: "TN-BT01", qty: 0 });
    await post("/admin/stock", { sku: "SAC-20W", qty: 0 });
    await sleep(config.metricsThrottleMs * 2);

    const metrics = sc.events.filter((e) => e.type === "metrics");
    expect(metrics.length).toBeLessThanOrEqual(3);
    expect(metrics.at(-1)!.data.newOrders).toBe(100); // gia tri cuoi luon dung
    expect(sc.alerts()).toHaveLength(2);
  });
});

// ===========================================================================
describe("rang buoc bo can bang tai 60 giay (thu nho: 1 giay)", () => {
  it("TC4: SSE thuan KHONG nhip tim -> ban dem yen tinh bi LB cat lien tuc", async () => {
    const naive = new EventSource(`${lbUrl}/stream?hb=0`);
    let opens = 0;
    naive.onopen = () => opens++;
    cleanups.push(() => naive.close());

    await sleep(LB_IDLE_MS * 3.5); // "ban dem": khong co thay doi nao
    expect(lb.stats.idleKills).toBeGreaterThanOrEqual(3);
    expect(opens).toBeGreaterThanOrEqual(3); // moi lan bi cat la 1 lan noi lai (+ khoang trong mu)
  });

  it("TC5: CO nhip tim -> qua 4 lan nguong 60s van giu NGUYEN 1 ket noi", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    await sleep(LB_IDLE_MS * 4);

    expect(lb.stats.idleKills).toBe(0);
    expect(sc.s.stats.opens).toBe(1);
    expect(sc.s.stats.watchdogFires).toBe(0);
    expect((await stats()).connectionsTotal).toBe(1);
    expect(sc.events.filter((e) => e.type === "heartbeat").length).toBeGreaterThanOrEqual(10);
  });
});

// ===========================================================================
describe("mang noi bo kho rot roi tu phuc hoi", () => {
  it("TC6: rot NGAN (vai giay) -> khong can noi lai, canh bao phat sinh luc rot van toi sau khi mang hoi phuc", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    lb.cut();
    await post("/admin/stock", { sku: "OP-IP15", qty: 0 });
    await sleep(500);
    lb.restore();

    await waitFor(() => sc.alerts().length === 1);
    expect(sc.s.stats.opens).toBe(1); // cung ket noi cu, TCP chuyen tiep goi bi giu
  });

  it("TC7: rot LAU (qua nguong LB) -> tu noi lai, PHAT BU dung cac su kien bi lo qua Last-Event-ID, khong trung", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    lb.cut();
    await post("/admin/stock", { sku: "TN-BT01", qty: 0 });
    await post("/admin/order", { count: 5, amount: 20_000 });
    await post("/admin/stock", { sku: "CAP-C1M", qty: 2 });
    await sleep(LB_IDLE_MS * 2); // LB cat ket noi, watchdog phia man hinh cung bao chet
    lb.restore();

    await waitFor(() => sc.alerts().length === 2 && sc.statuses.at(-1) === "live", 8_000);
    const st = await stats();
    expect(st.resumed).toBeGreaterThanOrEqual(1); // noi lai bang Last-Event-ID
    expect(st.snapshots).toBe(1); // chi snapshot luc mo man hinh
    expect(sc.alerts().map((a) => a.data.sku).sort()).toEqual(["CAP-C1M", "TN-BT01"]);
    await waitFor(() => sc.events.filter((e) => e.type === "metrics").at(-1)?.data.newOrders === 5);
  });

  it("TC8: server bao tri tra 503 -> EventSource goc BO CUOC, ReliableStream tu thu lai den khi duoc", async () => {
    const sc = screen();
    const naive = new EventSource(`${lbUrl}/stream`);
    cleanups.push(() => naive.close());
    await waitFor(() => sc.statuses.includes("live") && naive.readyState === EventSource.OPEN);

    await post("/admin/maintenance", { on: true });
    lb.dropAll(); // ca 2 bi rot -> noi lai -> gap 503
    await waitFor(() => naive.readyState === EventSource.CLOSED);
    await waitFor(() => sc.s.stats.httpFailures >= 1);
    await sleep(1_500);
    await post("/admin/maintenance", { on: false });

    await waitFor(() => sc.statuses.at(-1) === "live", 8_000);
    await sleep(500);
    expect(naive.readyState).toBe(EventSource.CLOSED); // man hinh dung EventSource tran: "chet" vinh vien
  });

  it("TC9: server khoi dong lai (Last-Event-ID cua lan truoc vo nghia) -> nhan SNAPSHOT moi thay vi phat bu sai", async () => {
    await post("/admin/order", { count: 7, amount: 1_000 });
    const sc = screen(`${base}/stream`);
    await waitFor(() => sc.events.some((e) => e.type === "snapshot"));
    expect(sc.events[0].data.newOrders).toBe(7);

    await app.close();
    ({ app } = await startServer(port)); // cung cong, trang thai moi
    await waitFor(() => sc.events.filter((e) => e.type === "snapshot").length === 2, 8_000);
    expect(sc.events.filter((e) => e.type === "snapshot").at(-1)!.data.newOrders).toBe(0);
  });

  it("TC10: mat qua lau (bo dem phat bu da troi) -> SNAPSHOT, so lieu van dung", async () => {
    const sc = screen();
    await waitFor(() => sc.statuses.includes("live"));
    lb.cut();
    for (let i = 0; i < 30; i++) await post("/admin/stock", { sku: "CAP-C1M", qty: i % 2 ? 2 : 50 }); // 30 su kien > bo dem 20
    await post("/admin/stock", { sku: "SAC-20W", qty: 0 });
    await sleep(LB_IDLE_MS * 1.5);
    lb.restore();

    await waitFor(() => sc.events.filter((e) => e.type === "snapshot").length === 2, 8_000);
    const snap = sc.events.filter((e) => e.type === "snapshot").at(-1)!.data;
    expect(snap.alerts.map((a: { sku: string }) => a.sku).sort()).toEqual(["CAP-C1M", "SAC-20W"]);
  });
});

// ===========================================================================
describe("giai phap so sanh: polling", () => {
  it("TC11: polling co ETag -> khong doi tra 304, doi thi tra 200", async () => {
    const r1 = await fetch(`${base}/api/snapshot`);
    const etag = r1.headers.get("etag")!;
    expect(r1.status).toBe(200);
    expect((await fetch(`${base}/api/snapshot`, { headers: { "If-None-Match": etag } })).status).toBe(304);
    await post("/admin/order", {});
    expect((await fetch(`${base}/api/snapshot`, { headers: { "If-None-Match": etag } })).status).toBe(200);
  });
});
