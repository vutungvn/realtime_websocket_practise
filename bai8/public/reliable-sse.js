// ReliableStream: boc EventSource de man hinh chay 24/7 KHONG BAO GIO "chet im lang".
// Dung chung cho trinh duyet (window.ReliableStream) va test Node (require).
//
// EventSource goc co 3 diem yeu khi chay 24/7 khong nguoi trong:
//   1. Server/LB tra loi HTTP loi (502/503 luc bao tri, deploy) -> EventSource BO CUOC (readyState = CLOSED).
//   2. Ket noi "song" nhung khong con du lieu (half-open: NAT/wifi reset, FIN bi mat) -> EventSource
//      van bao OPEN mai mai.
//   3. Thoi gian tu thu lai sau loi mang phu thuoc tung trinh duyet (EventSource MOI tao chua nhan `retry:`
//      cua server nen dung mac dinh ~3-5s), kho kiem soat.
// => Lop nay TU QUAN LY moi lan noi lai, 3 chinh sach rieng:
//   - loi mang                 -> thu lai sau retryMs (co dinh + jitter): mang hoi phuc la len ngay
//   - server tra loi HTTP loi   -> backoff tang dan toi maxBackoffMs: khong don dap server dang khoi dong
//   - im lang qua watchdogMs    -> dong va noi lai ngay
// Moi lan tao lai deu gui ?lastEventId= de server PHAT BU su kien bi lo.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReliableStream = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EVENT_TYPES = ["snapshot", "metrics", "stock-alert", "stock-cleared", "heartbeat"];

  function create(opts) {
    const ES = opts.EventSource || (typeof EventSource !== "undefined" ? EventSource : null);
    const watchdogMs = opts.watchdogMs || 25000;
    const retryMs = opts.retryMs || 2000;
    // 40 man hinh: toi da 40 request / 10s ~ 4 req/s luc te nhat -> tran 10s la du an toan,
    // va giu thoi gian hoi phuc sau khi server song lai <= 10s (khop SLA canh bao 10s).
    const minBackoffMs = opts.minBackoffMs || 1000;
    const maxBackoffMs = opts.maxBackoffMs || 10000;
    const log = opts.log || function () {};
    const onEvent = opts.onEvent || function () {};
    const onStatus = opts.onStatus || function () {};

    let es = null;
    let lastEventId = null;
    let watchdog = null;
    let retryTimer = null;
    let httpFailStreak = 0;
    let closed = false;
    let lastMessageAt = 0;
    let downSince = null;
    const stats = { opens: 0, reconnects: 0, networkErrors: 0, httpFailures: 0, watchdogFires: 0 };

    function status(state, detail) {
      if (state === "live") downSince = null;
      else if (downSince === null) downSince = Date.now();
      onStatus({ state, detail: detail || "", downSince, lastMessageAt, lastEventId, stats });
    }

    function urlWithResume() {
      if (!lastEventId) return opts.url;
      // EventSource moi tao khong dat duoc header Last-Event-ID -> gui qua query.
      return opts.url + (opts.url.indexOf("?") >= 0 ? "&" : "?") + "lastEventId=" + encodeURIComponent(lastEventId);
    }

    function connect() {
      if (closed) return;
      es = new ES(urlWithResume());
      status("connecting");
      armWatchdog();

      es.onopen = function () {
        httpFailStreak = 0;
        stats.opens++;
        log("ket noi SSE da mo");
        status("live");
      };

      EVENT_TYPES.forEach(function (type) {
        es.addEventListener(type, function (e) {
          lastMessageAt = Date.now();
          if (e.lastEventId) lastEventId = e.lastEventId; // nhip tim khong co id -> giu nguyen
          armWatchdog();
          if (type !== "heartbeat") onEvent(type, JSON.parse(e.data), e.lastEventId);
          else onEvent("heartbeat", Number(e.data), null);
        });
      });

      es.onerror = function () {
        if (closed) return;
        if (es.readyState === ES.CLOSED) {
          // (1) Server/LB tra loi loi HTTP: trinh duyet da bo cuoc -> backoff tang dan.
          stats.httpFailures++;
          const delay = Math.min(maxBackoffMs, minBackoffMs * Math.pow(2, httpFailStreak++));
          reconnectLater("server/LB tra loi loi HTTP", delay);
        } else {
          // (3) Loi mang (rot mang, LB dong ket noi): thu lai deu dan, mang len la noi duoc ngay.
          stats.networkErrors++;
          reconnectLater("mat ket noi mang", retryMs);
        }
      };
    }

    function armWatchdog() {
      clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        // (2) Qua lau khong nghe gi (ke ca nhip tim) -> coi nhu ket noi da chet du EventSource bao OPEN.
        stats.watchdogFires++;
        log("watchdog: " + watchdogMs + "ms khong co du lieu/nhip tim");
        reconnectLater("khong nhan duoc nhip tim", minBackoffMs);
      }, watchdogMs);
    }

    function reconnectLater(reason, baseDelay) {
      if (closed) return;
      clearTimeout(watchdog);
      clearTimeout(retryTimer);
      if (es) es.close(); // huy luon lich tu thu lai cua trinh duyet, de 1 noi duy nhat quyet dinh
      // Jitter 50-100%: 40 man hinh cung rot 1 luc se khong noi lai cung 1 tich tac.
      const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
      stats.reconnects++;
      log(reason + " -> tu noi lai sau " + delay + "ms");
      status("reconnecting", reason + ", thu lai sau " + Math.max(1, Math.round(delay / 1000)) + "s");
      retryTimer = setTimeout(connect, delay);
    }

    connect();

    return {
      stats: stats,
      get lastEventId() {
        return lastEventId;
      },
      get readyState() {
        return es ? es.readyState : 2;
      },
      close: function () {
        closed = true;
        clearTimeout(watchdog);
        clearTimeout(retryTimer);
        if (es) es.close();
      },
    };
  }

  return { create: create };
});
