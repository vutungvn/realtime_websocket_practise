// Cau hinh. PROFILE=demo rut ngan cac nguong de xem duoc "tac don", "het han loi moi"... trong vai chuc giay.
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const demo = process.env.PROFILE === "demo";
const pick = (normal: number, demoValue: number) => (demo ? demoValue : normal);

export const config = {
  port: num("PORT", 4000),
  profile: demo ? "demo" : "default",

  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-doi-khi-trien-khai-that",
  tokenTtlMs: num("TOKEN_TTL_MS", 8 * 3_600_000),

  /** Phat hien client chet im lang (mat song, tat may): <= pingInterval + pingTimeout. */
  pingIntervalMs: num("PING_INTERVAL_MS", 10_000),
  pingTimeoutMs: num("PING_TIMEOUT_MS", 5_000),
  /** Goi tin lon nhat duoc nhan (chong gui rac dung luong lon). */
  maxPayloadBytes: num("MAX_PAYLOAD_BYTES", 16_384),

  /** Tai xe khong tra loi loi moi trong khoang nay -> chuyen tai xe khac. */
  offerTimeoutMs: num("OFFER_TIMEOUT_MS", pick(30_000, 15_000)),
  /** Tai xe mat ket noi: cho quay lai trong khoang nay roi moi coi la offline. */
  driverGraceMs: num("DRIVER_GRACE_MS", pick(20_000, 10_000)),

  /** "Don tac": o qua lau trong 1 giai doan. */
  stuck: {
    waitingMs: num("STUCK_WAITING_MS", pick(3 * 60_000, 30_000)), // cho tai xe (pending/offered)
    assignedMs: num("STUCK_ASSIGNED_MS", pick(15 * 60_000, 60_000)), // da nhan nhung chua lay hang
    pickedUpMs: num("STUCK_PICKED_UP_MS", pick(45 * 60_000, 90_000)), // dang giao
  },
  monitorIntervalMs: num("MONITOR_INTERVAL_MS", 1_000),

  /** Vi tri tai xe: nhan toi da 1 lan / khoang nay, du hon thi bo (chong spam). */
  locationMinIntervalMs: num("LOCATION_MIN_INTERVAL_MS", 1_000),
};
