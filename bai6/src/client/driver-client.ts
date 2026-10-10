// driver-client.ts - ung dung tai xe (phia client), da dien du cac cho khuyet (1)-(4).
// Cho khuyet (5) nam o phia server: src/server/driver.gateway.ts + src/server/config.ts.
import { io, ManagerOptions, Socket, SocketOptions } from "socket.io-client";
import { fmtMs, log } from "../common/log";

export interface NewOrder {
  seq: number;
  orderId: string;
  zone: string;
  address: string;
  createdAt: string;
}

/** Trang thai hien thi cho tai xe (banner tren man hinh). */
export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "online"; socketId: string }
  | { kind: "reconnecting"; reason: string; attempt: number }
  | { kind: "waiting-network"; retryInMs: number } // da het so lan thu nhanh, cho thu cham
  | { kind: "rejected"; reason: string }; // server tu choi (token het han...) -> can dang nhap lai

export const RECONNECT_OPTIONS = {
  // (1) Tu dong ket noi lai khi rot ket noi ngoai y muon (mat song, ping timeout, server restart).
  reconnection: true,

  // (2) Gioi han so lan thu + do tre GIAN DAN (exponential backoff) co JITTER:
  //     delay(n) = min(reconnectionDelay * 2^(n-1), reconnectionDelayMax) +/- randomizationFactor
  //     -> ~1s, 2s, 4s, 8s, 16s, 30s, 30s, ...  (moi gia tri lech ngau nhien +/-50%)
  //     15 lan ~ 5-6 phut; het thi chuyen sang "thu cham" (SLOW_RETRY_MS), KHONG bo cuoc.
  reconnectionAttempts: 15,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 30_000,
  randomizationFactor: 0.5, // jitter: hang nghin tai xe ra khoi ham / server restart khong ap vao cung 1 thoi diem
  timeout: 5_000, // moi lan thu toi da 5s (mac dinh 20s qua lau tren mang di dong)
} satisfies Partial<ManagerOptions & SocketOptions>;

/** Sau khi het reconnectionAttempts: cu 60s thu lai 1 vong (tai xe khong phai thao tac gi). */
export const SLOW_RETRY_MS = 60_000;

export interface DriverAppOptions {
  serverUrl: string;
  token: string;
  zones: string[];
  /** Ghi de cau hinh (test/demo dung gia tri nho hon). */
  socketOptions?: Partial<ManagerOptions & SocketOptions>;
  slowRetryMs?: number;
  tag?: string;
  /** Tat log (demo nhieu tai xe cung luc). */
  silent?: boolean;
}

export function createDriverApp(opts: DriverAppOptions) {
  const tag = opts.tag ?? "DRIVER-APP";
  const say = (msg: string) => !opts.silent && log(tag, msg);
  const maxAttempts = opts.socketOptions?.reconnectionAttempts ?? RECONNECT_OPTIONS.reconnectionAttempts;
  const slowRetryMs = opts.slowRetryMs ?? SLOW_RETRY_MS;

  // Trang thai "mong muon" do CLIENT giu -> nguon su that de dang ky lai sau khi noi lai.
  const zones = new Set(opts.zones);
  let syncedSeq: number | null = null; // seq don cuoi cung da dong bo voi server

  const orders: NewOrder[] = [];
  const seenOrderIds = new Set<string>();
  /** Nhat ky cac lan thu lai: thoi gian cho thuc te truoc moi lan (de chung minh backoff gian dan). */
  const retryLog: { attempt: number; waitedMs: number }[] = [];
  let state: ConnectionState = { kind: "connecting" };
  let lastFailAt = 0;
  let disconnectedAt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const socket: Socket = io(opts.serverUrl, {
    auth: { token: opts.token },
    transports: ["websocket"], // app di dong: bo long-polling -> it request HTTP hon moi lan noi lai
    ...RECONNECT_OPTIONS,
    ...opts.socketOptions,
  });

  const setState = (next: ConnectionState) => {
    state = next;
  };

  const scheduleManualRetry = (ms: number, why: string) => {
    clearTimeout(retryTimer);
    setState({ kind: "waiting-network", retryInMs: ms });
    say(`${why} -> banner "Khong co ket noi, tu thu lai sau ${fmtMs(ms)}"`);
    retryTimer = setTimeout(() => {
      if (closed) return;
      lastFailAt = Date.now();
      say("thu ket noi lai (vong moi)");
      socket.connect();
    }, ms);
  };

  const receive = (order: NewOrder, via: string) => {
    syncedSeq = Math.max(syncedSeq ?? 0, order.seq);
    if (seenOrderIds.has(order.orderId)) return; // chong trung (vd don vua bu vua phat lai)
    seenOrderIds.add(order.orderId);
    orders.push(order);
    say(`📦 nhan don ${order.orderId} [${order.zone}] ${order.address}${via}`);
  };

  // Listener nghiep vu dang ky DUY NHAT 1 lan, o NGOAI "connect".
  // (Neu dat trong "connect", moi lan noi lai them 1 listener -> 1 don hien N lan.)
  socket.on("order:new", (order: NewOrder) => receive(order, ""));

  socket.on("connect", () => {
    clearTimeout(retryTimer);
    const downtime = disconnectedAt ? ` | gian doan ${fmtMs(Date.now() - disconnectedAt)}` : "";
    say(`🟢 da ket noi, socket ${socket.id}${downtime}`);
    // (3) Dang ky lai room sau khi noi lai.
    // Moi lan noi lai la 1 socket MOI tren server (id moi, khong room nao) -> phai xin lai.
    void resubscribe();
  });

  async function resubscribe() {
    const sinceSeq = syncedSeq;
    try {
      const res = await socket.timeout(5_000).emitWithAck("driver:subscribe", { zones: [...zones], sinceSeq });
      if (!res?.ok) {
        say(`dang ky room bi tu choi: ${JSON.stringify(res)}`);
        return;
      }
      say(`dang ky lai room: ${res.rooms.join(", ")}`);
      (res.missed as NewOrder[]).forEach((o) => receive(o, " (bu don bi lo luc mat mang)"));
      syncedSeq = Math.max(syncedSeq ?? 0, res.serverSeq);
      disconnectedAt = 0;
      setState({ kind: "online", socketId: socket.id! });
      say(`banner: "Dang truc tuyen - san sang nhan don" (${zones.size} khu vuc)`);
    } catch {
      // Server khong tra loi kip: neu van con ket noi thi thu lai, neu da rot thi "connect" lan sau se lo.
      if (socket.connected) setTimeout(resubscribe, 2_000);
    }
  }

  // (4) Xu ly mat ket noi -> bao cho tai xe biet + theo doi qua trinh noi lai.
  socket.on("disconnect", (reason) => {
    if (closed) return;
    disconnectedAt = lastFailAt = Date.now();
    setState({ kind: "reconnecting", reason, attempt: 0 });
    say(`🔴 MAT KET NOI (ly do: ${reason}) -> banner "Mat ket noi - dang thu ket noi lai..."`);
    if (reason === "io server disconnect") {
      // Server chu dong ngat: Socket.IO KHONG tu noi lai trong truong hop nay -> tu goi.
      socket.connect();
    }
  });

  socket.io.on("reconnect_attempt", (attempt) => {
    const waitedMs = Date.now() - lastFailAt;
    retryLog.push({ attempt, waitedMs });
    setState({ kind: "reconnecting", reason: "dang thu", attempt });
    say(`↻ thu noi lai lan ${attempt}/${maxAttempts} (da cho ${fmtMs(waitedMs)})`);
  });

  socket.io.on("reconnect_error", (err) => {
    lastFailAt = Date.now();
    say(`  lan thu that bai: ${err.message}`);
  });

  socket.io.on("reconnect", (attempt) => {
    say(`✅ noi lai thanh cong o lan thu ${attempt}`);
  });

  socket.io.on("reconnect_failed", () => {
    // Het so lan thu nhanh: khong spam server, nhung cung khong bat tai xe tat/mo app.
    scheduleManualRetry(slowRetryMs, `⛔ het ${maxAttempts} lan thu`);
  });

  socket.on("connect_error", (err: Error & { data?: { retryAfterMs?: number } }) => {
    if (socket.active) return; // dang trong vong tu noi lai -> da xu ly o reconnect_error
    // Server tu choi o middleware -> Socket.IO dung han, khong tu thu lai.
    if (err.message === "rate_limited") {
      scheduleManualRetry(err.data?.retryAfterMs ?? slowRetryMs, "server bao ket noi qua day (rate_limited)");
      return;
    }
    setState({ kind: "rejected", reason: err.message });
    say(`⛔ server tu choi: ${err.message} -> banner "Phien dang nhap het han, vui long dang nhap lai"`);
  });

  return {
    socket,
    orders,
    retryLog,
    get state() {
      return state;
    },
    setZones(next: string[]) {
      zones.clear();
      next.forEach((z) => zones.add(z));
      if (socket.connected) void resubscribe();
    },
    /** Tai xe dang xuat / dong app dung cach. */
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket.disconnect();
    },
  };
}

export type DriverApp = ReturnType<typeof createDriverApp>;
