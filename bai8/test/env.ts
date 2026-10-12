// Thu nho moi moc thoi gian ~60 lan de test chay nhanh, giu nguyen TY LE:
//   that:  LB cat sau 60s | nhip tim 10s  | watchdog 25s  | retry 2s
//   test:  LB cat sau 1s  | nhip tim 300ms | watchdog 750ms | retry 200ms
process.env.HEARTBEAT_MS = "300";
process.env.SSE_RETRY_MS = "200";
process.env.METRICS_THROTTLE_MS = "200";
process.env.REPLAY_BUFFER = "20";
process.env.SIM_MODE = "off";
process.env.QUIET = "1";
