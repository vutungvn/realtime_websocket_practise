// Cau hinh phia server. Doc tu bien moi truong de test/demo co the rut ngan thoi gian.
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const serverConfig = {
  port: num("PORT", 4000),

  // (5) Nguong cho truoc khi coi client la mat ket noi (heartbeat cua Engine.IO):
  //   - Moi pingInterval, server gui "ping"; client phai tra "pong" trong pingTimeout.
  //   - Client chet / mat song -> server phat hien cham nhat sau pingInterval + pingTimeout.
  //   Mac dinh Socket.IO la 25s + 20s = 45s: qua cham cho dieu phoi giao hang.
  //   Dat qua thap (vd 2s + 1s) thi mang di dong hoi lag cung bi tinh la rot -> reconnect vo ich.
  pingIntervalMs: num("PING_INTERVAL_MS", 10_000),
  pingTimeoutMs: num("PING_TIMEOUT_MS", 5_000),

  // Sau khi mat socket cuoi cung, cho them 1 khoang "an han" roi moi danh dau OFFLINE.
  // Mang chap chon (rot 1-2s roi noi lai ngay) se khong lam trang thai tai xe nhay online/offline.
  offlineGraceMs: num("OFFLINE_GRACE_MS", 5_000),

  // Lop bao ve cuoi cung chong bao ket noi: moi tai xe toi da N lan bat tay / cua so thoi gian.
  connectRateLimit: num("CONNECT_RATE_LIMIT", 20),
  connectRateWindowMs: num("CONNECT_RATE_WINDOW_MS", 60_000),
};
