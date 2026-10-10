// BAY DU LIEU: mang chap chon bat/tat 10 lan trong 30 giay, 50 tai xe cung luc.
// So sanh cau hinh DUNG (backoff + jitter + gioi han) voi cau hinh SAI (thu lai lien tuc).
//   npm run demo:flap   -> in bang ket qua + ghi logs/flap-demo.log
import { ManagerOptions } from "socket.io-client";
import { fmtMs, log, logToFile, muteTags, sleep } from "../common/log";
import { createDriverApp, DriverApp, RECONNECT_OPTIONS } from "../client/driver-client";
import { startServer } from "../server/bootstrap";
import { ChaosProxy } from "../tools/chaos-proxy";

const N_DRIVERS = 50;
const FLAPS = 10;
const DOWN_MS = 1_500;
const UP_MS = 1_500; // 10 x (1.5s + 1.5s) = 30 giay
const zoneOf = (i: number) => `khu-${i % 5}`;

const SCENARIOS: { name: string; options: Partial<ManagerOptions> }[] = [
  { name: "DUNG (backoff 1s->30s, jitter 50%, toi da 15 lan)", options: {} },
  {
    name: "SAI  (co dinh 100ms, khong jitter, vo han)",
    options: { reconnectionDelay: 100, reconnectionDelayMax: 100, randomizationFactor: 0, reconnectionAttempts: Infinity },
  },
];

/** So lan thu nhieu nhat trong 1 cua so truot `windowMs`. */
function peak(times: number[], windowMs: number) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; j < t.length; j++) {
    while (t[j] - t[i] >= windowMs) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

async function waitUntil(cond: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !cond()) await sleep(50);
  return cond();
}

async function runScenario(name: string, options: Partial<ManagerOptions>) {
  log("DEMO", `========== ${name} ==========`);
  const { app, port } = await startServer(0);
  const base = `http://127.0.0.1:${port}`;
  const proxy = new ChaosProxy(0, { host: "127.0.0.1", port }, () => {});
  const proxyPort = await proxy.start();

  const drivers: DriverApp[] = [];
  for (let i = 0; i < N_DRIVERS; i++) {
    drivers.push(
      createDriverApp({
        serverUrl: `http://127.0.0.1:${proxyPort}`,
        token: `tok_driver-${String(i).padStart(2, "0")}`,
        zones: [zoneOf(i)],
        socketOptions: options,
        silent: true,
      }),
    );
  }
  await waitUntil(() => drivers.every((d) => d.state.kind === "online"), 15_000);
  const startStats = (await (await fetch(`${base}/stats`)).json()) as { handshakes: number };
  proxy.stats.attempts = 0;
  proxy.attemptTimes.length = 0;

  for (let f = 1; f <= FLAPS; f++) {
    proxy.dropAll();
    proxy.cut();
    await sleep(DOWN_MS);
    proxy.restore();
    await sleep(UP_MS);
    const online = drivers.filter((d) => d.state.kind === "online").length;
    log("DEMO", `chap chon ${f}/${FLAPS}: so lan thu ket noi tich luy ${proxy.stats.attempts}, dang online ${online}/${N_DRIVERS}`);
  }

  const settleStart = Date.now();
  const allBack = await waitUntil(() => drivers.every((d) => d.state.kind === "online"), 40_000);
  const settleMs = Date.now() - settleStart;
  const stats = (await (await fetch(`${base}/stats`)).json()) as { handshakes: number };

  // Kiem tra dung nghiep vu sau bao: moi tai xe nhan dung 1 lan don moi cua khu minh.
  const before = drivers.map((d) => d.orders.length);
  for (let z = 0; z < 5; z++) {
    await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: `khu-${z}` }),
    });
  }
  await sleep(1_000);
  const exactlyOnce = drivers.every(
    (d, i) => d.orders.length - before[i] === 1 && d.orders.at(-1)?.zone === zoneOf(i) && d.socket.listeners("order:new").length === 1,
  );

  const result = {
    name,
    attempts: proxy.stats.attempts,
    handshakes: stats.handshakes - startStats.handshakes,
    peakPerSec: peak(proxy.attemptTimes, 1_000),
    peakPer100ms: peak(proxy.attemptTimes, 100),
    allBack,
    settleMs,
    exactlyOnce,
  };

  drivers.forEach((d) => d.close());
  await proxy.stop();
  await app.close();
  return result;
}

async function main() {
  muteTags("SERVER", "DISPATCH");
  logToFile("logs/flap-demo.log");
  log("DEMO", `${N_DRIVERS} tai xe, mang chap chon ${FLAPS} lan / ${((DOWN_MS + UP_MS) * FLAPS) / 1000}s (moi lan: cat ngang + mat song ${DOWN_MS}ms + co song ${UP_MS}ms)`);
  log("DEMO", `cau hinh dung: ${JSON.stringify(RECONNECT_OPTIONS)}`);

  const results = [];
  for (const s of SCENARIOS) results.push(await runScenario(s.name, s.options));

  log("DEMO", "================ KET QUA ================");
  for (const r of results) {
    log("DEMO", r.name);
    log("DEMO", `  tong so lan thu ket noi tu ${N_DRIVERS} dien thoai : ${r.attempts}  (~${(r.attempts / N_DRIVERS).toFixed(1)} lan/tai xe)`);
    log("DEMO", `  so lan bat tay toi server               : ${r.handshakes}`);
    log("DEMO", `  dinh trong 1 giay / trong 100ms          : ${r.peakPerSec} / ${r.peakPer100ms}`);
    log("DEMO", `  tat ca online lai sau bao                : ${r.allBack ? "CO" : "KHONG"} (${fmtMs(r.settleMs)} sau lan chap chon cuoi)`);
    log("DEMO", `  moi tai xe nhan don moi dung 1 lan       : ${r.exactlyOnce ? "DUNG" : "SAI"}`);
  }
  const [good, bad] = results;
  log("DEMO", `=> cau hinh sai tao ra gap ${(bad.attempts / good.attempts).toFixed(1)} lan so request, dinh 100ms gap ${(bad.peakPer100ms / good.peakPer100ms).toFixed(1)} lan`);
  process.exit(0);
}

main();
