// Chay TRUOC khi import code: rut ngan moi moc thoi gian de test chay nhanh.
// (ty le giong cau hinh that: ping 10s/5s/an han 5s  ->  300ms/300ms/400ms)
process.env.PING_INTERVAL_MS = "300";
process.env.PING_TIMEOUT_MS = "300";
process.env.OFFLINE_GRACE_MS = "400";
process.env.CONNECT_RATE_LIMIT = "20";
process.env.CONNECT_RATE_WINDOW_MS = "60000";
process.env.QUIET = "1";
