// THI NGHIEM DINH LUONG: 40 man hinh polling vs 40 man hinh SSE (+ 40 SSE "ngay tho" khong nhip tim),
// cung 1 server, moi giai phap di qua 1 bo can bang tai gia lap rieng de dem byte.
//
//   npm run compare             -> thu nho thoi gian 10 lan (~75 giay), ghi logs/compare.log
//   SCALE=1 npm run compare     -> thoi gian that (~12 phut)
//
// Moi moc thoi gian deu chia cho SCALE (LB 60s, nhip tim 10s, poll 5s, thay doi 5s...).
// Do tre polling do bang chu ky poll nen nhan lai SCALE de quy ve thoi gian that;
// do tre SSE do bang mang (khong phu thuoc SCALE) nen giu nguyen.
export {};

const SCALE = Number(process.env.SCALE ?? 10);
const S = (ms: number) => Math.round(ms / SCALE);
process.env.HEARTBEAT_MS = String(S(10_000));
process.env.SSE_RETRY_MS = String(S(2_000));
process.env.METRICS_THROTTLE_MS = String(S(1_000));
process.env.SIM_MODE = "off";
process.env.QUIET = "1";

/* eslint-disable @typescript-eslint/no-require-imports */
const { EventSource } = require("eventsource");
const { log, logToFile, muteTags, sleep } = require("../log");
const { startServer } = require("../server/bootstrap");
const { watchdogMs } = require("../server/config");
const { LoadBalancerSim } = require("../tools/lb-sim");
const ReliableStream = require("../../public/reliable-sse.js");

const N = 40;
const LB_IDLE = S(60_000);
const POLL_MS = S(5_000);
const PEAK_MS = S(5 * 60_000); // 5 phut gio cao diem
const NIGHT_MS = S(5 * 60_000); // 5 phut ban dem khong thay doi

type Bucket = { latencies: number[]; seen: Set<string> };
const bucket = (): Bucket => ({ latencies: [], seen: new Set() });

async function main() {
  process.env.QUIET = "";
  logToFile("logs/compare.log");
  muteTags("SERVER", "SIM", "LB");
  const say = (m: string) => log("THI-NGHIEM", m);

  const { app, port } = await startServer(0);
  const base = `http://127.0.0.1:${port}`;
  const mkLb = async () => {
    const lb = new LoadBalancerSim(0, { host: "127.0.0.1", port }, LB_IDLE, () => {});
    return { lb, url: `http://127.0.0.1:${await lb.start()}` };
  };
  const sse = await mkLb();
  const poll = await mkLb();
  const naive = await mkLb();
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  say(`SCALE=${SCALE}: LB cat sau ${LB_IDLE}ms, nhip tim ${S(10_000)}ms, poll ${POLL_MS}ms, ${N} man hinh moi giai phap`);

  // ---------------------------------------------------------------- 40 man hinh SSE
  const sseAlerts = bucket();
  const sseScreens = Array.from({ length: N }, () =>
    ReliableStream.create({
      url: `${sse.url}/stream`,
      EventSource,
      watchdogMs: watchdogMs(),
      minBackoffMs: S(1_000),
      retryMs: S(2_000),
      onEvent: (type: string, d: { alertId: string; createdAt: number }) => {
        if (type !== "stock-alert") return;
        sseAlerts.latencies.push(Date.now() - d.createdAt);
        sseAlerts.seen.add(d.alertId);
      },
    }),
  );

  // ---------------------------------------------------------------- 40 man hinh polling (ETag)
  const pollAlerts = bucket();
  let polling = true;
  let pollRequests = 0;
  const pollers = Array.from({ length: N }, async (_, i) => {
    await sleep(Math.random() * POLL_MS); // cac man hinh khong poll cung luc
    let etag: string | null = null;
    const known = new Set<string>();
    while (polling) {
      try {
        pollRequests++;
        const r: Response = await fetch(`${poll.url}/api/snapshot`, { headers: etag ? { "If-None-Match": etag } : {} });
        if (r.status === 200) {
          etag = r.headers.get("etag");
          const { state } = (await r.json()) as { state: { alerts: { alertId: string; createdAt: number }[] } };
          for (const a of state.alerts) {
            if (known.has(a.alertId)) continue;
            known.add(a.alertId);
            pollAlerts.latencies.push((Date.now() - a.createdAt) * SCALE); // moi man hinh 1 mau
            pollAlerts.seen.add(a.alertId);
          }
        } else await r.arrayBuffer();
      } catch {}
      await sleep(POLL_MS);
    }
  });

  await sleep(S(3_000));
  const snap = () => ({ sse: { ...sse.lb.stats }, poll: { ...poll.lb.stats }, req: pollRequests });

  // ---------------------------------------------------------------- PHA 1: gio cao diem
  say(`PHA 1 - GIO CAO DIEM: thay doi ~moi 5s, ${PEAK_MS * SCALE / 60_000} phut`);
  const p1 = snap();
  const skus = ["TN-BT01", "SAC-20W", "OP-IP15", "CAP-C1M"];
  let alertsCreated = 0;
  const peakEnd = Date.now() + PEAK_MS;
  for (let i = 0; Date.now() < peakEnd; i++) {
    await post("/admin/order", { count: 1 + (i % 3), amount: 150_000 });
    if (i % 6 === 3) {
      const sku = skus[(i / 6) % 4 | 0];
      await post("/admin/stock", { sku, qty: 0 });
      alertsCreated++;
      setTimeout(() => post("/admin/stock", { sku, qty: 50 }), S(20_000)); // nhap hang sau ~20s
    }
    await sleep(S(5_000));
  }
  await sleep(POLL_MS * 2);
  const p1e = snap();
  const pollLat = pollAlerts.latencies.slice(); // chi tinh pha 1
  const sseLat = sseAlerts.latencies.slice();

  // ---------------------------------------------------------------- PHA 2: ban dem
  say(`PHA 2 - BAN DEM: ${NIGHT_MS * SCALE / 60_000} phut KHONG co thay doi nao; them ${N} man hinh SSE "ngay tho" (khong nhip tim)`);
  let naiveOpens = 0;
  const naiveScreens = Array.from({ length: N }, () => {
    const es = new EventSource(`${naive.url}/stream?hb=0`);
    es.onopen = () => naiveOpens++;
    return es;
  });
  await sleep(S(2_000));
  const p2 = snap();
  const naiveOpensStart = naiveOpens;
  const naiveKillsStart = naive.lb.stats.idleKills;
  const sseOpensStart = sseScreens.reduce((s: number, x: { stats: { opens: number } }) => s + x.stats.opens, 0);
  await sleep(NIGHT_MS);
  const p2e = snap();
  const sseOpensNight = sseScreens.reduce((s: number, x: { stats: { opens: number } }) => s + x.stats.opens, 0) - sseOpensStart;
  const naiveReopens = naiveOpens - naiveOpensStart;
  const naiveKills = naive.lb.stats.idleKills - naiveKillsStart;
  naiveScreens.forEach((e) => e.close());

  // ---------------------------------------------------------------- PHA 3: mang kho rot
  say("PHA 3 - MANG KHO ROT 90 GIAY (qua nguong LB 60s), co 2 canh bao phat sinh luc rot");
  const before3 = sseAlerts.latencies.length;
  const pollBefore3 = pollAlerts.latencies.length;
  const stats3a = await (await fetch(`${base}/api/stats`)).json();
  sse.lb.cut();
  poll.lb.cut();
  await post("/admin/stock", { sku: "TN-BT01", qty: 0 });
  await sleep(S(30_000));
  await post("/admin/stock", { sku: "SAC-20W", qty: 1 });
  await sleep(S(60_000));
  const restoredAt = Date.now();
  sse.lb.restore();
  poll.lb.restore();
  const t0 = Date.now();
  let sseRecover = 0, pollRecover = 0;
  while ((!sseRecover || !pollRecover) && Date.now() - t0 < S(120_000)) {
    if (!sseRecover && sseAlerts.latencies.length >= before3 + 2 * N) sseRecover = Date.now() - restoredAt;
    if (!pollRecover && pollAlerts.latencies.length >= pollBefore3 + 2 * N) pollRecover = Date.now() - restoredAt;
    await sleep(20);
  }
  const deliveredAfterDrop = sseAlerts.latencies.length - before3;
  const stats3 = await (await fetch(`${base}/api/stats`)).json();

  // ---------------------------------------------------------------- KET QUA
  polling = false;
  await Promise.race([Promise.all(pollers), sleep(POLL_MS * 3)]);
  sseScreens.forEach((s: { close: () => void }) => s.close());

  const peakSec = PEAK_MS * SCALE / 1000;
  const nightSec = NIGHT_MS * SCALE / 1000;
  const perDay = (count: number, sec: number) => Math.round((count / sec) * 86_400);
  const avg = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
  const max = (a: number[]) => Math.max(0, ...a);
  const kb = (b: number) => `${(b / 1024).toFixed(0)}KB`;
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;

  say("==================== KET QUA (quy ve thoi gian that) ====================");
  say(`PHA 1 cao diem ${peakSec / 60} phut, ${alertsCreated} canh bao:`);
  say(`  POLLING : ${p1e.req - p1.req} request, ${kb(p1e.poll.bytesDown - p1.poll.bytesDown)} tai xuong | do tre canh bao TB ${(avg(pollLat) / 1000).toFixed(1)}s, toi da ${(max(pollLat) / 1000).toFixed(1)}s`);
  say(`  SSE     : 0 request moi (giu ${N} ket noi), ${kb(p1e.sse.bytesDown - p1.sse.bytesDown)} tai xuong | do tre canh bao TB ${avg(sseLat)}ms, toi da ${max(sseLat)}ms`);
  say(`PHA 2 ban dem ${nightSec / 60} phut, 0 thay doi:`);
  say(`  POLLING : ${p2e.req - p2.req} request (gan nhu toan 304 vo ich), ${kb(p2e.poll.bytesDown - p2.poll.bytesDown)} -> ~${perDay(p2e.req - p2.req, nightSec).toLocaleString("vi-VN")} request/ngay`);
  say(`  SSE+nhip tim: LB cat ${p2e.sse.idleKills - p2.sse.idleKills} lan, noi lai ${sseOpensNight} lan, ${kb(p2e.sse.bytesDown - p2.sse.bytesDown)} nhip tim -> ~${mb(((p2e.sse.bytesDown - p2.sse.bytesDown) / nightSec) * 86_400)}/ngay`);
  say(`  SSE ngay tho (khong nhip tim): LB cat ${naiveKills} lan, noi lai ${naiveReopens} lan -> ~${perDay(naiveReopens, nightSec).toLocaleString("vi-VN")} lan noi lai/ngay`);
  say(`PHA 3 mang rot 90s:`);
  say(`  SSE    : ${deliveredAfterDrop}/${2 * N} canh bao toi du, ${((sseRecover / 1000) * SCALE).toFixed(1)}s sau khi mang hoi phuc | noi lai bang Last-Event-ID ${stats3.resumed - stats3a.resumed} lan, snapshot ${stats3.snapshots - stats3a.snapshots} lan`);
  say(`  POLLING: ${pollAlerts.latencies.length - pollBefore3}/${2 * N} canh bao toi du, ${pollRecover ? ((pollRecover / 1000) * SCALE).toFixed(1) + "s" : "chua du"} sau khi mang hoi phuc`);

  await Promise.all([sse.lb.stop(), poll.lb.stop(), naive.lb.stop()]);
  await app.close();
  process.exit(0);
}

main();
