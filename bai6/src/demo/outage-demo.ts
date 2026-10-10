// Kich ban chay thu de NOP LOG: tai xe vao ham mat mang 15 giay roi ra, sau do tat han app.
//   npm run demo:outage   -> in ra man hinh + ghi logs/outage-demo.log
// Dung cau hinh that (ping 10s + 5s, an han 5s), mang gia lap bang ChaosProxy.
import { fmtMs, log, logToFile, sleep } from "../common/log";
import { createDriverApp, NewOrder } from "../client/driver-client";
import { startServer } from "../server/bootstrap";
import { serverConfig } from "../server/config";
import { ChaosProxy } from "../tools/chaos-proxy";

const DRIVER = "driver-01";
const ZONES = ["cau-giay", "dong-da"];
const DISPATCH_ZONES = ["cau-giay", "dong-da", "ba-dinh"]; // ba-dinh: tai xe KHONG dang ky -> khong duoc nhan
const OUTAGE_MS = 15_000;

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  logToFile("logs/outage-demo.log");
  const phase = (title: string) => log("DEMO", `========== ${title} ==========`);

  const { app, port } = await startServer(0);
  const base = `http://127.0.0.1:${port}`;
  const proxy = new ChaosProxy(0, { host: "127.0.0.1", port });
  const proxyPort = await proxy.start();
  log("DEMO", `server :${port}, mang gia lap :${proxyPort} | app tai xe -> mang gia lap -> server`);

  const presence = async () => {
    const list = (await (await fetch(`${base}/drivers`)).json()) as { driverId: string; status: string; rooms: string[] }[];
    return list.find((d) => d.driverId === DRIVER);
  };

  phase("1. BINH THUONG: tai xe mo app");
  const driver = createDriverApp({ serverUrl: `http://127.0.0.1:${proxyPort}`, token: `tok_${DRIVER}`, zones: ZONES });
  await waitUntil(() => driver.state.kind === "online", 10_000);
  // Dieu phoi (bat dau khi tai xe da online): cu 4 giay tao 1 don, xoay vong cac khu vuc.
  const created: NewOrder[] = [];
  let dispatching = true;
  void (async () => {
    for (let i = 0; dispatching; i++) {
      const zone = DISPATCH_ZONES[i % DISPATCH_ZONES.length];
      const res = await fetch(`${base}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone, address: `${100 + i} duong demo, ${zone}` }),
      });
      created.push(((await res.json()) as { order: NewOrder }).order);
      await sleep(4_000);
    }
  })();

  const before = await presence();
  const socketBefore = driver.socket.id;
  log("DEMO", `room tren server TRUOC khi mat mang: ${before?.rooms.join(", ")}`);
  await sleep(5_000);

  phase(`2. TAI XE VAO HAM: mat mang ${OUTAGE_MS / 1000} giay`);
  proxy.cut();
  const cutAt = Date.now();
  await sleep(OUTAGE_MS);

  phase("3. RA KHOI HAM: co mang lai, app tu noi lai (tai xe khong thao tac gi)");
  proxy.restore();
  const ok = await waitUntil(() => driver.state.kind === "online" && driver.socket.id !== socketBefore, 60_000);
  const after = await presence();
  log("DEMO", `tu noi lai: ${ok ? "CO" : "KHONG"} | socket ${socketBefore} -> ${driver.socket.id} | tong gian doan ${fmtMs(Date.now() - cutAt)}`);
  log("DEMO", `room tren server SAU khi noi lai: ${after?.rooms.join(", ")}`);
  const sameRooms = JSON.stringify(before?.rooms) === JSON.stringify(after?.rooms);
  log("DEMO", `room giong truoc khi mat mang: ${sameRooms ? "DUNG" : "SAI"}`);

  const receivedBefore = driver.orders.length;
  await waitUntil(() => driver.orders.length > receivedBefore, 15_000);
  log("DEMO", `nhan duoc don MOI sau khi noi lai: ${driver.orders.length > receivedBefore ? "CO" : "KHONG"}`);
  dispatching = false;
  await sleep(500);

  const expected = created.filter((o) => ZONES.includes(o.zone)).map((o) => o.orderId);
  const got = driver.orders.map((o) => o.orderId);
  const lost = expected.filter((id) => !got.includes(id));
  log("DEMO", `don thuoc khu vuc tai xe: ${expected.length}, da nhan: ${got.length}, bi mat: ${lost.length ? lost.join(",") : "0"}`);
  log("DEMO", `do tre giua cac lan thu lai: ${driver.retryLog.map((r) => `#${r.attempt}=${fmtMs(r.waitedMs)}`).join(", ") || "(noi lai ngay lan dau)"}`);

  phase("4. TAT HAN APP: dien thoai het pin trong vung mat song (server khong nhan duoc tin bao dong)");
  proxy.cut();
  driver.close();
  const killedAt = Date.now();
  const maxExpected = serverConfig.pingIntervalMs + serverConfig.pingTimeoutMs + serverConfig.offlineGraceMs;
  log("DEMO", `server phai danh dau OFFLINE trong <= ping ${serverConfig.pingIntervalMs} + pong ${serverConfig.pingTimeoutMs} + an han ${serverConfig.offlineGraceMs} = ${fmtMs(maxExpected)}`);
  await waitUntil(async () => (await presence())?.status === "offline", maxExpected + 5_000);
  log("DEMO", `server danh dau OFFLINE sau ${fmtMs(Date.now() - killedAt)} (trang thai: ${(await presence())?.status})`);

  phase("KET THUC");
  await proxy.stop();
  await app.close();
  process.exit(0);
}

main();
