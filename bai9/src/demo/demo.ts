// KICH BAN DEMO: 6 vai hoat dong DONG THOI (1 dieu phoi, 2 khach, 3 tai xe) + 1 ke la khong token.
//   npm run demo   -> in ra man hinh + ghi logs/demo.log
// Rut ngan nguong (loi moi 3s, an han 3s, don tac 4s) de xem het trong ~40 giay.
export {};
process.env.OFFER_TIMEOUT_MS = "3000";
process.env.DRIVER_GRACE_MS = "3000";
process.env.STUCK_WAITING_MS = "4000";
process.env.LOCATION_MIN_INTERVAL_MS = "200";
process.env.PING_INTERVAL_MS = "1000";
process.env.PING_TIMEOUT_MS = "1000";

/* eslint-disable @typescript-eslint/no-require-imports */
const { io } = require("socket.io-client");
const { log, logToFile, muteTags, sleep } = require("../log");
const { startServer } = require("../bootstrap");
const { ChaosProxy } = require("../tools/chaos-proxy");

type Ev = { name: string; data: any };
const PICK_A = { lat: 21.0285, lng: 105.8542, address: "Ho Guom, Hoan Kiem" };
const DROP_A = { lat: 21.0189, lng: 105.8365, address: "Van Mieu, Dong Da" };
const PICK_B = { lat: 21.006, lng: 105.822, address: "Nga Tu So, Dong Da" };
const DROP_B = { lat: 21.0012, lng: 105.8205, address: "Royal City, Thanh Xuan" };

async function main() {
  logToFile("logs/demo.log");
  muteTags("GATEWAY");
  const step = (t: string) => log("DEMO", `========== ${t} ==========`);
  const { app, port } = await startServer(0);
  const base = `http://127.0.0.1:${port}`;
  const proxy = new ChaosProxy(0, { host: "127.0.0.1", port }, (m: string) => log("MANG", m));
  const proxyUrl = `http://127.0.0.1:${await proxy.start()}`;
  // Rieng tai xe Hung di qua 1 duong mang khac -> co the lam rot mang CHI cua Hung.
  const hungLine = new ChaosProxy(0, { host: "127.0.0.1", port }, (m: string) => log("MANG-HUNG", m));
  const hungUrl = `http://127.0.0.1:${await hungLine.start()}`;

  /** Cho co gioi han: kich ban khong bao gio treo; qua han thi ghi ro buoc nao khong dat. */
  const waitUntil = async (label: string, cond: () => boolean, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(100);
    }
    log("DEMO", `(!) qua ${timeoutMs / 1000}s ma chua thay: ${label}`);
    return false;
  };

  const token = async (userId: string) =>
    (await (await fetch(`${base}/auth/demo-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) })).json()).token;

  /** 1 vai = 1 socket qua mang gia lap (de co the ngat dot ngot). Ghi lai MOI su kien nhan duoc. */
  async function actor(userId: string, tag: string) {
    const events: Ev[] = [];
    const presence = new Map<string, string>();
    const socket = io(userId === "d-hung" ? hungUrl : proxyUrl, { auth: { token: await token(userId) }, transports: ["websocket"], reconnectionDelay: 300 });
    socket.onAny((name: string, data: any) => {
      events.push({ name, data });
      if (name === "order:updated") log(tag, `<- order:updated ${data.order.id} = ${data.order.status}${data.order.driver ? ` (tai xe ${data.order.driver.name})` : ""}${data.order.stuck ? " [TAC]" : ""}`);
      else if (name === "offer:new") log(tag, `<- offer:new ${data.offer.orderId} (${data.offer.distanceKm}km, ${data.offer.byDispatcher ? "dieu phoi giao" : "tu dong"})`);
      else if (name === "offer:closed") log(tag, `<- offer:closed ${data.orderId}: ${data.reason}`);
      else if (name === "alert:raised") log(tag, `<- 🚨 alert:raised ${data.alert.id} ${data.alert.kind}: ${data.alert.message}`);
      else if (name === "alert:updated") log(tag, `<- alert:updated ${data.alertId} = ${data.status}${data.handledBy ? ` (${data.handledBy})` : ""}`);
      else if (name === "session:ready") log(tag, `<- session:ready (${data.user.role} ${data.user.name})`);
      else if (name === "driver:updated") {
        // vi tri cap nhat lien tuc -> chi ghi khi KET NOI / VIEC cua tai xe doi
        const key = `${data.driver.presence}/${data.driver.onShift ? "ca" : "nghi"}/${data.driver.activity}`;
        if (presence.get(data.driver.id) !== key) log(tag, `<- driver:updated ${data.driver.name}: ${key}`);
        presence.set(data.driver.id, key);
      }
    });
    await new Promise((ok) => socket.once("session:ready", ok));
    const emit = (name: string, p: unknown) => socket.timeout(3000).emitWithAck(name, p);
    return { socket, events, emit, of: (n: string) => events.filter((e) => e.name === n).map((e) => e.data) };
  }

  /** Bot tai xe: tu chay toi diem lay/giao, tu bao tien do. acceptAuto=false: lo loi moi tu dong, chi nhan khi dieu phoi giao. */
  function driverBot(a: Awaited<ReturnType<typeof actor>>, tag: string, start: { lat: number; lng: number }, acceptAuto: boolean) {
    let pos = { ...start };
    let job: any = null;
    a.socket.on("offer:new", async ({ offer }: any) => {
      if (!acceptAuto && !offer.byDispatcher) return log(tag, `(dang ban, khong tra loi loi moi ${offer.orderId})`);
      await sleep(400);
      const r = await a.emit("offer:respond", { orderId: offer.orderId, accept: true });
      if (r.ok) { job = r.order; log(tag, `-> offer:respond NHAN ${offer.orderId}`); }
    });
    a.socket.on("session:ready", ({ snapshot }: any) => { if (snapshot.currentOrder) job = snapshot.currentOrder; });
    const timer = setInterval(async () => {
      if (!a.socket.connected || !job) return;
      const target = job.status === "assigned" ? job.pickup : job.dropoff;
      const d = Math.hypot(target.lat - pos.lat, target.lng - pos.lng);
      const k = Math.min(1, 0.0005 / Math.max(d, 1e-9)); // ~55m / 0,3s ~ toc do xe may trong pho
      pos = { lat: pos.lat + (target.lat - pos.lat) * k, lng: pos.lng + (target.lng - pos.lng) * k };
      a.socket.emit("driver:location", pos);
      if (k === 1) {
        const status = job.status === "assigned" ? "picked_up" : "delivered";
        const r = await a.emit("order:progress", { orderId: job.id, status });
        if (r.ok) { log(tag, `-> order:progress ${job.id} = ${status}`); job = status === "delivered" ? null : r.order; }
      }
    }, 300);
    return { stop: () => clearInterval(timer) };
  }

  // ================================================================
  step("0. Ke la ket noi KHONG token / token gia");
  for (const auth of [{}, { token: "gia.mao.token" }]) {
    const msg = await new Promise((ok) => {
      const s = io(base, { auth, transports: ["websocket"], reconnection: false, forceNew: true });
      s.once("connect", () => ok("KET NOI DUOC (sai!)"));
      s.once("connect_error", (e: Error) => ok(e.message));
    });
    log("KE-LA", `bi tu choi tai buoc bat tay: ${msg}`);
  }

  step("1. Ca 6 vai dang nhap va ket noi song song");
  const [op, lan, minh, hung, tuan, mai] = await Promise.all([
    actor("op-ha", "DIEU-PHOI"), actor("c-lan", "KHACH-LAN"), actor("c-minh", "KHACH-MINH"),
    actor("d-hung", "TX-HUNG"), actor("d-tuan", "TX-TUAN"), actor("d-mai", "TX-MAI"),
  ]);
  const bots = [
    driverBot(hung, "TX-HUNG", { lat: 21.028, lng: 105.85 }, true),
    driverBot(tuan, "TX-TUAN", { lat: 21.005, lng: 105.82 }, false),
    driverBot(mai, "TX-MAI", { lat: 21.04, lng: 105.8 }, true),
  ];
  await hung.emit("driver:shift", { onShift: true });
  await tuan.emit("driver:shift", { onShift: true });
  log("DEMO", "Hung, Tuan vao ca; Mai chua vao ca");

  step("2. Khach Lan dat don gan Hung -> tu dong moi Hung -> Hung nhan va chay");
  const a = await lan.emit("order:place", { pickup: PICK_A, dropoff: DROP_A });
  await sleep(2500);

  step("3. Khach Minh dat don -> moi Tuan, Tuan khong tra loi -> het han -> khong con ai ranh -> DON TAC");
  const b = await minh.emit("order:place", { pickup: PICK_B, dropoff: DROP_B });
  await waitUntil("canh bao don tac", () => op.of("alert:raised").some((x) => x.alert.orderId === b.order.id));
  const stuck = op.of("alert:raised").find((x) => x.alert.orderId === b.order.id)?.alert;

  step("4. Dieu phoi vien CAN THIEP: nhan xu ly canh bao, giao tay don cho Tuan");
  if (stuck) await op.emit("alert:ack", { alertId: stuck.id });
  const assign = await op.emit("dispatch:assign", { orderId: b.order.id, driverId: "d-tuan" });
  log("DIEU-PHOI", `-> dispatch:assign ${b.order.id} cho Tuan: ${assign.ok ? "OK" : assign.error}`);
  await sleep(2000);

  step("5. Tai xe Hung MAT KET NOI DOT NGOT giua duong (mang rot) -> dieu phoi duoc bao -> Hung tu noi lai");
  hungLine.cut(); // CHI mang cua Hung rot: khong goi tin dong nao toi duoc server
  await sleep(6000); // > heartbeat (2s) + an han (3s)
  hungLine.restore();
  await sleep(2500);

  step("6. Mai vao ca; Lan dat them don -> Mai nhan; dieu phoi huy don nay theo yeu cau khach");
  await mai.emit("driver:shift", { onShift: true });
  const c = await lan.emit("order:place", { pickup: PICK_B, dropoff: PICK_A });
  await sleep(1500);
  const cancel = await op.emit("dispatch:cancel", { orderId: c.order.id, reason: "Khach goi dien huy" });
  log("DIEU-PHOI", `-> dispatch:cancel ${c.order.id}: ${cancel.ok ? "OK" : cancel.error}`);

  step("7. Doi cac don giao xong");
  const delivered = (id: string) => op.of("order:updated").some((u) => u.order.id === id && u.order.status === "delivered");
  await waitUntil("2 don giao xong", () => delivered(a.order.id) && delivered(b.order.id), 30_000);

  step("8. Kiem tra PHAM VI du lieu moi vai nhan duoc");
  const ids = (x: any, n = "order:updated") => [...new Set(x.of(n).map((u: any) => u.order?.id ?? u.orderId ?? u.offer?.orderId))].sort();
  const count = (x: any, n: string) => x.of(n).length;
  const check = (label: string, ok: boolean) => log("KIEM-TRA", `${ok ? "DUNG" : "SAI "} | ${label}`);
  check(`Lan chi thay don cua minh ${JSON.stringify(ids(lan))}`, ids(lan).every((id) => id === a.order.id || id === c.order.id));
  check(`Minh chi thay don cua minh ${JSON.stringify(ids(minh))}`, ids(minh).every((id) => id === b.order.id));
  const own = (x: any) => new Set(x.of("order:updated").map((u: any) => u.order.id));
  check(`Lan nhan ${count(lan, "courier:location")} vi tri tai xe, Minh nhan ${count(minh, "courier:location")} - MOI vi tri deu thuoc don cua chinh nguoi do`,
    lan.of("courier:location").every((p: any) => own(lan).has(p.orderId)) && minh.of("courier:location").every((p: any) => own(minh).has(p.orderId)));
  check(`Hung chi duoc moi don ${JSON.stringify(ids(hung, "offer:new"))}`, ids(hung, "offer:new").every((id) => id === a.order.id));
  for (const [name, x] of [["Lan", lan], ["Minh", minh], ["Hung", hung], ["Tuan", tuan], ["Mai", mai]] as const) {
    check(`${name}: 0 driver:updated, 0 alert (thong tin noi bo dieu phoi)`, count(x, "driver:updated") + count(x, "alert:raised") + count(x, "alert:updated") === 0);
  }
  for (const [name, x] of [["Lan", lan], ["Minh", minh]] as const) check(`${name}: 0 offer:new (khach khong thay loi moi tai xe)`, count(x, "offer:new") === 0);
  check(`Dieu phoi thay toan canh: ${ids(op).length} don, ${count(op, "driver:updated")} cap nhat tai xe, ${count(op, "alert:raised")} canh bao`, ids(op).length === 3);

  step("9. NGAT DOT NGOT TAT CA client (RST) -> tai nguyen server ve 0");
  bots.forEach((x) => x.stop());
  [op, lan, minh, hung, tuan, mai].forEach((x) => x.socket.io.reconnection(false));
  proxy.dropAll();
  hungLine.dropAll();
  await sleep(3500); // > an han tai xe
  const res = await (await fetch(`${base}/debug/resources`, { headers: { Authorization: `Bearer ${await token("op-ha")}` } })).json();
  log("KIEM-TRA", `tai nguyen sau khi moi client roi di: ${JSON.stringify(res)}`);
  check("sockets=0, rooms=0, sessionTimers=0, driverSockets=0, graceTimers=0, offerTimers=0",
    ["sockets", "rooms", "sessionTimers", "driverSockets", "graceTimers", "offerTimers"].every((k) => res[k] === 0));
  check("server van song: dang nhap moi van duoc", typeof (await token("c-lan")) === "string");

  await proxy.stop();
  await hungLine.stop();
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
