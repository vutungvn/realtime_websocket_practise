// Cau hinh doc tu bien moi truong (test / thi nghiem thu nho thoi gian).
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export type SimMode = "peak" | "night" | "off";

export const config = {
  port: num("PORT", 4000),

  /**
   * Nhip tim SSE. Bo can bang tai cat ket noi im lang qua 60s, nen phai < 60s.
   * Chon 10s: (1) du an toan gap 6 lan, mat 5 nhip lien tiep van song;
   *           (2) client phat hien ket noi chet "im lang" trong ~25s (watchdog);
   *           (3) chi phi ~0: 40 man hinh x 8.640 nhip/ngay x ~50 byte ~ 17MB/ngay.
   */
  heartbeatMs: num("HEARTBEAT_MS", 10_000),
  /** Truong `retry:` cua SSE: trinh duyet cho bao lau truoc khi tu noi lai sau loi mang. */
  retryMs: num("SSE_RETRY_MS", 2_000),
  /** So lieu (don, doanh thu) la "gia tri moi nhat", gop lai toi da 1 lan / khoang nay. Canh bao KHONG gop. */
  metricsThrottleMs: num("METRICS_THROTTLE_MS", 1_000),
  /** So su kien gan nhat giu lai de phat bu khi client noi lai (Last-Event-ID). */
  replayBufferSize: num("REPLAY_BUFFER", 1_000),

  simMode: (["peak", "night", "off"].includes(process.env.SIM_MODE ?? "") ? process.env.SIM_MODE : "peak") as SimMode,
  peakIntervalMs: num("PEAK_INTERVAL_MS", 5_000),
  nightIntervalMs: num("NIGHT_INTERVAL_MS", 120_000),
};

/** Client tu coi ket noi da chet neu khong nghe gi (ke ca nhip tim) trong khoang nay. */
export const watchdogMs = () => Math.round(config.heartbeatMs * 2.5);
