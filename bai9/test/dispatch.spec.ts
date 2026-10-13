// Kiem thu end-to-end: server NestJS that + client socket.io that cho tung vai + proxy de ngat dot ngot.
import { INestApplication } from "@nestjs/common";
import { io, Socket } from "socket.io-client";
import { TokenService } from "../src/auth/token.service";
import { startServer } from "../src/bootstrap";
import { config } from "../src/config";
import { sleep } from "../src/log";
import { ChaosProxy } from "../src/tools/chaos-proxy";

let app: INestApplication;
let base: string;
let proxy: ChaosProxy;
let proxyUrl: string;
const opened: Socket[] = [];

const PICK = { lat: 21.03, lng: 105.85, address: "12 Hang Bai, Hoan Kiem" }; // gan Hung nhat, roi toi Tuan, Mai
const DROP = { lat: 21.01, lng: 105.82, address: "99 Lang Ha, Dong Da" };

beforeEach(async () => {
  const s = await startServer(0);
  app = s.app;
  base = `http://127.0.0.1:${s.port}`;
  proxy = new ChaosProxy(0, { host: "127.0.0.1", port: s.port }, () => {});
  proxyUrl = `http://127.0.0.1:${await proxy.start()}`;
});

afterEach(async () => {
  opened.splice(0).forEach((s) => s.disconnect());
  await proxy.stop();
  await app.close();
});

// ---------------------------------------------------------------- tien ich
async function tokenOf(userId: string) {
  const r = await fetch(`${base}/auth/demo-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  return ((await r.json()) as { token: string }).token;
}

interface Client {
  socket: Socket;
  events: { name: string; data: any }[];
  snapshot: any;
  of: (name: string) => any[];
  emit: (name: string, payload: unknown) => Promise<any>;
}

/** Dang nhap + ket noi 1 vai; ghi lai MOI su kien nhan duoc de kiem tra pham vi. */
async function connect(userId: string, { viaProxy = false, token }: { viaProxy?: boolean; token?: string } = {}): Promise<Client> {
  const socket = io(viaProxy ? proxyUrl : base, {
    auth: { token: token ?? (await tokenOf(userId)) },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  opened.push(socket);
  const events: { name: string; data: any }[] = [];
  socket.onAny((name, data) => events.push({ name, data }));
  const ready = await new Promise<any>((ok, fail) => {
    socket.once("session:ready", ok);
    socket.once("connect_error", fail);
  });
  return {
    socket,
    events,
    snapshot: ready.snapshot,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.data),
    emit: (name, payload) => socket.timeout(3_000).emitWithAck(name, payload),
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error(`het ${timeoutMs}ms ma dieu kien chua dung`);
}

async function resources() {
  const r = await fetch(`${base}/debug/resources`, { headers: { Authorization: `Bearer ${await tokenOf("op-ha")}` } });
  return r.json() as Promise<Record<string, number>>;
}

/** 3 tai xe vao ca. */
async function driversOnShift(...ids: string[]) {
  const list = await Promise.all(ids.map((id) => connect(id)));
  for (const d of list) expect((await d.emit("driver:shift", { onShift: true })).ok).toBe(true);
  return list;
}

const handshakeError = (opts: Parameters<typeof io>[1]) =>
  new Promise<string>((ok) => {
    const s = io(base, { ...opts, transports: ["websocket"], reconnection: false, forceNew: true });
    opened.push(s);
    s.once("connect", () => ok("CONNECTED"));
    s.once("connect_error", (e) => ok(e.message));
  });

// ===========================================================================
describe("1. Xac thuc tai buoc bat tay", () => {
  it("A1: khong token -> bi tu choi ngay (AUTH_REQUIRED), khong co socket nao duoc tao", async () => {
    expect(await handshakeError({})).toBe("AUTH_REQUIRED");
    expect(await handshakeError({ auth: { token: "" } })).toBe("AUTH_REQUIRED");
    const r = await resources();
    expect(r.sockets).toBe(0);
    expect(r.rejectedHandshakes).toBe(2);
  });

  it("A2: token gia mao (sua vai thanh dieu phoi) / rac -> AUTH_INVALID", async () => {
    const real = await tokenOf("c-lan");
    const [h, p, sig] = real.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, role: "dispatcher" })).toString("base64url")}.${sig}`;
    expect(await handshakeError({ auth: { token: forged } })).toBe("AUTH_INVALID");
    expect(await handshakeError({ auth: { token: "abc.def.ghi" } })).toBe("AUTH_INVALID");
  });

  it("A3: token het han -> AUTH_EXPIRED", async () => {
    const expired = new TokenService().sign({ id: "c-lan", role: "customer", name: "Chi Lan" }, -1_000);
    expect(await handshakeError({ auth: { token: expired } })).toBe("AUTH_EXPIRED");
  });

  it("A4: API kiem tra tai nguyen cung can token dieu phoi (401 / 403)", async () => {
    expect((await fetch(`${base}/debug/resources`)).status).toBe(401);
    const asCustomer = await fetch(`${base}/debug/resources`, { headers: { Authorization: `Bearer ${await tokenOf("c-lan")}` } });
    expect(asCustomer.status).toBe(403);
  });
});

// ===========================================================================
describe("2. Moi vai chi nhan du lieu thuoc pham vi cua minh", () => {
  it("S1: khach chi thay don cua minh; dieu phoi thay tat ca", async () => {
    const op = await connect("op-ha");
    const lan = await connect("c-lan");
    const minh = await connect("c-minh");

    const a = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    const b = await minh.emit("order:place", { pickup: DROP, dropoff: PICK });
    await waitFor(() => op.of("order:updated").some((u) => u.order.id === b.order.id));

    expect(new Set(lan.of("order:updated").map((u) => u.order.id))).toEqual(new Set([a.order.id]));
    expect(new Set(minh.of("order:updated").map((u) => u.order.id))).toEqual(new Set([b.order.id]));
    expect(new Set(op.of("order:updated").map((u) => u.order.id))).toEqual(new Set([a.order.id, b.order.id]));

    const lan2 = await connect("c-lan"); // mo them may: snapshot cung chi co don cua Lan
    expect(lan2.snapshot.orders.map((o: any) => o.id)).toEqual([a.order.id]);
  });

  it("S2: loi moi chi toi DUNG tai xe gan nhat; tai xe & khach khong nhan thong tin dieu phoi noi bo", async () => {
    const op = await connect("op-ha");
    const [hung, tuan, mai] = await driversOnShift("d-hung", "d-tuan", "d-mai");
    const lan = await connect("c-lan");
    await lan.emit("order:place", { pickup: PICK, dropoff: DROP });

    await waitFor(() => hung.of("offer:new").length === 1);
    await sleep(200);
    expect(tuan.of("offer:new")).toHaveLength(0);
    expect(mai.of("offer:new")).toHaveLength(0);
    for (const c of [hung, tuan, mai, lan]) {
      expect(c.of("driver:updated")).toHaveLength(0);
      expect(c.of("alert:raised")).toHaveLength(0);
    }
    expect(op.of("driver:updated").length).toBeGreaterThan(0);
  });

  it("S3: vi tri tai xe CHI toi khach co don dang duoc giao, va dung khi giao xong", async () => {
    const [hung] = await driversOnShift("d-hung");
    const lan = await connect("c-lan");
    const minh = await connect("c-minh");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);

    await hung.emit("driver:location", { lat: 21.029, lng: 105.85 }); // chua nhan don -> khach chua duoc thay
    await hung.emit("offer:respond", { orderId: order.id, accept: true });
    await sleep(150);
    await hung.emit("driver:location", { lat: 21.031, lng: 105.851 });
    await waitFor(() => lan.of("courier:location").length === 1);
    expect(lan.of("courier:location")[0]).toMatchObject({ orderId: order.id, lat: 21.031 });

    await hung.emit("order:progress", { orderId: order.id, status: "picked_up" });
    await hung.emit("order:progress", { orderId: order.id, status: "delivered" });
    await sleep(150);
    await hung.emit("driver:location", { lat: 21.02, lng: 105.83 });
    await sleep(200);
    expect(lan.of("courier:location")).toHaveLength(1);
    expect(minh.events.filter((e) => e.name !== "session:ready")).toHaveLength(0); // Minh khong nhan GI ca
  });

  it("S4: noi dung cat theo vai: khach khong thay du lieu noi bo, tai xe khong thay so dien thoai day du", async () => {
    const [hung, tuan] = await driversOnShift("d-hung", "d-tuan");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);
    await hung.emit("offer:respond", { orderId: order.id, accept: false }); // Hung tu choi -> moi Tuan
    await waitFor(() => tuan.of("offer:new").length === 1);
    await tuan.emit("offer:respond", { orderId: order.id, accept: true });
    await waitFor(() => lan.of("order:updated").some((u) => u.order.status === "assigned"));

    const seen = lan.of("order:updated").map((u) => u.order);
    for (const o of seen) {
      expect(o).not.toHaveProperty("rejectedBy");
      expect(o).not.toHaveProperty("history");
      expect(o).not.toHaveProperty("customer");
      expect(o.status).not.toBe("offered"); // "dang moi tai xe" la noi bo
    }
    expect(seen.at(-1).driver).toEqual({ name: "Tuan", vehicle: "Vision 29B2-678.90" });

    const forDriver = tuan.of("order:updated").at(-1).order;
    expect(forDriver.customer).toEqual({ name: "Chi Lan", phoneMasked: "091****678" });
    expect(hung.of("order:updated")).toHaveLength(0); // da tu choi -> khong thay don nua
  });

  it("S5: gui su kien ngoai quyen -> FORBIDDEN, khong anh huong ai", async () => {
    const [hung, tuan] = await driversOnShift("d-hung", "d-tuan");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);

    expect(await lan.emit("dispatch:assign", { orderId: order.id, driverId: "d-tuan" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await hung.emit("order:place", { pickup: PICK, dropoff: DROP })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await tuan.emit("offer:respond", { orderId: order.id, accept: true })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    await hung.emit("offer:respond", { orderId: order.id, accept: true });
    expect(await tuan.emit("order:progress", { orderId: order.id, status: "picked_up" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

// ===========================================================================
describe("3. Nghiep vu dieu phoi", () => {
  it("B1: vong doi day du: dat -> moi -> nhan -> lay hang -> giao xong -> tai xe ranh lai", async () => {
    const op = await connect("op-ha");
    const [hung] = await driversOnShift("d-hung");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);
    expect(hung.of("offer:new")[0].offer).toMatchObject({ orderId: order.id, byDispatcher: false });

    await hung.emit("offer:respond", { orderId: order.id, accept: true });
    await hung.emit("order:progress", { orderId: order.id, status: "picked_up" });
    expect(await hung.emit("order:progress", { orderId: order.id, status: "picked_up" })).toMatchObject({ code: "CONFLICT" });
    await hung.emit("order:progress", { orderId: order.id, status: "delivered" });

    await waitFor(() => lan.of("order:updated").at(-1)?.order.status === "delivered");
    expect(lan.of("order:updated").map((u) => u.order.status)).toEqual(["pending", "pending", "assigned", "picked_up", "delivered"]);
    await waitFor(() => op.of("driver:updated").at(-1)?.driver.activity === "idle");
  });

  it("B2: tai xe khong tra loi -> loi moi het han, chuyen tai xe gan ke tiep", async () => {
    const [hung, tuan] = await driversOnShift("d-hung", "d-tuan");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);

    await waitFor(() => tuan.of("offer:new").length === 1, config.offerTimeoutMs + 1_000);
    expect(hung.of("offer:closed")).toEqual([{ orderId: order.id, reason: "expired" }]);
    expect(await hung.emit("offer:respond", { orderId: order.id, accept: true })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("B3: moi tai xe tu choi -> DON TAC -> canh bao chi toi dieu phoi -> dieu phoi giao tay -> canh bao tu dong ket thuc", async () => {
    const op = await connect("op-ha");
    const [hung] = await driversOnShift("d-hung");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);
    await hung.emit("offer:respond", { orderId: order.id, accept: false });

    await waitFor(() => op.of("alert:raised").length === 1, config.stuck.waitingMs + 1_000);
    const alert = op.of("alert:raised")[0].alert;
    expect(alert).toMatchObject({ kind: "order_stuck", orderId: order.id, status: "open" });
    expect(op.of("order:updated").at(-1).order.stuck).toBe(true);
    expect(lan.of("alert:raised")).toHaveLength(0);
    expect(hung.of("alert:raised")).toHaveLength(0);

    const r = await op.emit("dispatch:assign", { orderId: order.id, driverId: "d-hung" });
    expect(r.ok).toBe(true);
    await waitFor(() => hung.of("offer:new").length === 2);
    expect(hung.of("offer:new")[1].offer.byDispatcher).toBe(true);
    await hung.emit("offer:respond", { orderId: order.id, accept: true });
    await waitFor(() => op.of("alert:updated").some((u) => u.alertId === alert.id && u.status === "resolved"));
  });

  it("B4: dieu phoi huy don / nhan xu ly canh bao -> moi ben lien quan duoc bao", async () => {
    const ha = await connect("op-ha");
    const nam = await connect("op-nam");
    const [hung] = await driversOnShift("d-hung");
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);
    await hung.emit("offer:respond", { orderId: order.id, accept: false });
    await waitFor(() => ha.of("alert:raised").length === 1, config.stuck.waitingMs + 1_000);

    const alertId = ha.of("alert:raised")[0].alert.id;
    expect((await ha.emit("alert:ack", { alertId })).ok).toBe(true);
    await waitFor(() => nam.of("alert:updated").some((u) => u.status === "acknowledged" && u.handledBy === "op-ha"));

    expect(await ha.emit("dispatch:cancel", { orderId: order.id, reason: "x" })).toMatchObject({ code: "INVALID" });
    expect((await ha.emit("dispatch:cancel", { orderId: order.id, reason: "Khach goi huy" })).ok).toBe(true);
    await waitFor(() => lan.of("order:updated").at(-1)?.order.status === "cancelled");
  });
});

// ===========================================================================
describe("4. Chiu loi va khong ro ri tai nguyen", () => {
  it("R1: du lieu rac / sai kieu / ngoai vung -> INVALID, server van chay binh thuong", async () => {
    const lan = await connect("c-lan");
    const bad: unknown[] = [
      undefined,
      "hello",
      42,
      { pickup: PICK },
      { pickup: { ...PICK, lat: "21" }, dropoff: DROP },
      { pickup: { ...PICK, lat: 48.85 }, dropoff: DROP }, // Paris
      { pickup: { ...PICK, address: "x".repeat(500) }, dropoff: DROP },
    ];
    for (const b of bad) expect(await lan.emit("order:place", b)).toMatchObject({ ok: false, code: "INVALID" });
    expect((await lan.emit("order:place", { pickup: PICK, dropoff: DROP })).ok).toBe(true);
  });

  it("R2: goi tin qua lon -> chi socket do bi ngat, nguoi khac khong anh huong", async () => {
    const lan = await connect("c-lan");
    const minh = await connect("c-minh");
    const gone = new Promise((ok) => lan.socket.once("disconnect", ok));
    lan.socket.emit("order:place", { pickup: { ...PICK, address: "x".repeat(50_000) }, dropoff: DROP });
    await gone;
    expect((await minh.emit("order:place", { pickup: PICK, dropoff: DROP })).ok).toBe(true);
  });

  it("R3: tai xe dang co loi moi bi NGAT DOT NGOT -> loi moi chuyen NGAY tai xe khac", async () => {
    const op = await connect("op-ha");
    const hung = await connect("d-hung", { viaProxy: true });
    await hung.emit("driver:shift", { onShift: true });
    const [tuan] = await driversOnShift("d-tuan");
    const lan = await connect("c-lan");
    await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);

    proxy.dropAll(); // RST: nhu dien thoai mat song dot ngot
    await waitFor(() => tuan.of("offer:new").length === 1, 2_000);
    await waitFor(() => op.of("driver:updated").some((u) => u.driver.id === "d-hung" && u.driver.presence === "lost"));
    await waitFor(() => op.of("driver:updated").some((u) => u.driver.id === "d-hung" && u.driver.presence === "offline"), config.driverGraceMs + 1_000);
  });

  it("R4: tai xe dang giao bi ngat -> het an han bao dieu phoi; quay lai -> canh bao tu het, van con don", async () => {
    const op = await connect("op-ha");
    const hung = await connect("d-hung", { viaProxy: true });
    await hung.emit("driver:shift", { onShift: true });
    const lan = await connect("c-lan");
    const { order } = await lan.emit("order:place", { pickup: PICK, dropoff: DROP });
    await waitFor(() => hung.of("offer:new").length === 1);
    await hung.emit("offer:respond", { orderId: order.id, accept: true });
    await hung.emit("order:progress", { orderId: order.id, status: "picked_up" });

    proxy.dropAll();
    await waitFor(() => op.of("alert:raised").some((a) => a.alert.kind === "driver_lost"), config.driverGraceMs + 1_000);
    expect(op.of("alert:raised").find((a) => a.alert.kind === "driver_lost").alert.orderId).toBe(order.id);

    const back = await connect("d-hung");
    expect(back.snapshot.currentOrder).toMatchObject({ id: order.id, status: "picked_up" });
    await waitFor(() => op.of("alert:updated").some((u) => u.status === "resolved"));
  });

  it("R5: 30 client nhieu vai cung bi ngat dot ngot -> tai nguyen ve 0", async () => {
    const ids = ["c-lan", "c-minh", "d-hung", "d-tuan", "d-mai", "op-nam"];
    const clients = await Promise.all(Array.from({ length: 30 }, (_, i) => connect(ids[i % ids.length], { viaProxy: true })));
    await Promise.all(clients.filter((_, i) => ids[i % ids.length].startsWith("d-")).map((c) => c.emit("driver:shift", { onShift: true })));
    const lan = clients[0];
    await lan.emit("order:place", { pickup: PICK, dropoff: DROP }); // co loi moi dang cho -> co timer
    const before = await resources();
    expect(before.sockets).toBe(30);
    expect(before.offerTimers).toBe(1);

    proxy.dropAll();
    await waitFor(async () => (await resources()).sockets === 0);
    await sleep(config.driverGraceMs + 300);
    const after = await resources();
    expect(after).toMatchObject({ sockets: 0, rooms: 0, sessionTimers: 0, driverSockets: 0, graceTimers: 0, offerTimers: 0 });
  });

  it("R6: client chet IM LANG (khong goi tin dong) -> phat hien bang heartbeat va don sach", async () => {
    const mai = await connect("d-mai", { viaProxy: true });
    await mai.emit("driver:shift", { onShift: true });
    proxy.cut(); // mang treo: khong FIN, khong RST
    mai.socket.disconnect(); // goi tin bao dong bi ket lai trong proxy
    await waitFor(async () => (await resources()).sockets === 0, config.pingIntervalMs + config.pingTimeoutMs + 1_000);
    await sleep(config.driverGraceMs + 300);
    expect(await resources()).toMatchObject({ sockets: 0, rooms: 0, sessionTimers: 0, driverSockets: 0, graceTimers: 0 });
  });
});
