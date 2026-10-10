// Logic dung chung cho customer.html va agent.html (ban trinh duyet cua src/client/chat-client.ts).
window.ChatCommon = (() => {
  const INVISIBLE = /[​-‍⁠﻿]/g;
  let cfg = { messageMaxLength: 2000, typingIdleMs: 3000, typingThrottleMs: 1000 };

  async function loadConfig() {
    try {
      cfg = await (await fetch("/config")).json();
    } catch {}
    return cfg;
  }

  const count = (n) => n.toLocaleString("vi-VN");

  /** Cung quy tac voi src/shared/message-rules.ts - chan som o trinh duyet. */
  function checkText(raw) {
    const max = cfg.messageMaxLength;
    if (raw.length > max * 4) return tooLong(raw.length, max);
    const text = raw.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").trim();
    if (!text) return { ok: false, code: "EMPTY", error: "Bạn chưa nhập nội dung. Hãy gõ vài chữ trước khi gửi nhé!" };
    const len = [...text].length;
    if (len > max) return tooLong(len, max);
    return { ok: true, text };
  }
  function tooLong(len, max) {
    return {
      ok: false,
      code: "TOO_LONG",
      error: `Tin nhắn dài ${count(len)} ký tự, vượt giới hạn ${count(max)} ký tự. Bạn vui lòng rút gọn hoặc chia thành nhiều tin nhỏ hơn nhé.`,
    };
  }
  const visibleLength = (raw) => [...raw.replace(INVISIBLE, "").trim()].length;

  // randomUUID chi co tren https/localhost; mo qua IP LAN thi dung du phong.
  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  /** Dang soan tin: start toi da 1 lan / throttle; stop sau typingIdleMs khong go. */
  function typingController(socket) {
    let lastStart = 0, idle, current = null;
    return {
      keystroke(sessionId) {
        const now = Date.now();
        if (now - lastStart >= cfg.typingThrottleMs || current !== sessionId) {
          socket.emit("typing:start", { sessionId });
          lastStart = now;
        }
        current = sessionId;
        clearTimeout(idle);
        idle = setTimeout(() => this.stop(), cfg.typingIdleMs);
      },
      stop() {
        clearTimeout(idle);
        if (current) socket.emit("typing:stop", { sessionId: current });
        current = null;
        lastStart = 0;
      },
      /** Da gui tin: server tu tat, chi can reset phia client. */
      reset() {
        clearTimeout(idle);
        current = null;
        lastStart = 0;
      },
    };
  }

  /** Gui tin; mat ack thi gui lai CUNG clientMsgId (server tra tin cu, khong nhan doi). */
  async function sendWithRetry(socket, payload) {
    for (let i = 0; i < 3; i++) {
      try {
        return await socket.timeout(3000).emitWithAck("message:send", payload);
      } catch {}
    }
    return { ok: false, code: "NETWORK", error: "Không gửi được tin nhắn, bạn kiểm tra kết nối mạng rồi thử lại nhé." };
  }

  const time = (ts) => new Date(ts).toLocaleTimeString("vi-VN", { hour12: false });

  /**
   * Ve lai khung tin nhan tu Map(id -> message) + danh sach dang gui.
   * Ve theo id => cung 1 tin nhan nhieu lan (ack + su kien + lich su) van chi 1 dong.
   */
  function render(box, { messages, pending, myRole, otherReadUpTo, latency, otherLabel }) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.replaceChildren();
    const sorted = [...messages.values()].sort((a, b) => a.seq - b.seq);
    const lastSeenMine = sorted.filter((m) => m.senderRole === myRole && m.seq <= otherReadUpTo).at(-1);

    for (const m of sorted) {
      const kind = m.senderRole === "system" ? "system" : m.senderRole === myRole ? "mine" : "theirs";
      const el = document.createElement("div");
      el.className = `msg ${kind}`;
      const body = document.createElement("div");
      body.className = "bubble";
      body.textContent = m.text; // textContent: khong bao gio chen HTML cua nguoi dung (chong XSS)
      el.append(body);
      if (kind !== "system") {
        const meta = document.createElement("div");
        meta.className = "meta";
        const lat = latency.get(m.id);
        meta.textContent = `#${m.seq} · ${time(m.createdAt)}` + (lat !== undefined ? ` · ⏱ ${lat}ms` : "");
        if (m === lastSeenMine) meta.textContent += ` · ✓✓ ${otherLabel} đã xem`;
        el.append(meta);
      }
      box.append(el);
    }
    for (const p of pending.values()) {
      const el = document.createElement("div");
      el.className = "msg mine pending";
      el.innerHTML = `<div class="bubble"></div><div class="meta">Đang gửi…</div>`;
      el.firstChild.textContent = p.text;
      box.append(el);
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }

  return { loadConfig, checkText, visibleLength, uuid, typingController, sendWithRetry, render, count, get cfg() { return cfg; } };
})();
