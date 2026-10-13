// Dung chung cho 3 trang vai: dang nhap demo, ket noi socket CO TOKEN, ban do, tien ich.
window.App = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const time = (t) => (t ? new Date(t).toLocaleTimeString("vi-VN", { hour12: false }) : "—");
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s` : "—");

  const STATUS = {
    pending: "Chờ tài xế",
    offered: "Đang mời tài xế",
    assigned: "Tài xế đang tới lấy",
    picked_up: "Đang giao",
    delivered: "Đã giao",
    cancelled: "Đã huỷ",
  };

  /** Dang nhap demo -> token -> ket noi socket. Token chi nam trong bo nho tab. */
  async function connect(userId, role, handlers) {
    const r = await fetch("/auth/demo-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
    if (!r.ok) throw new Error("Không đăng nhập được " + userId);
    const { token, user } = await r.json();
    if (user.role !== role) throw new Error(`${userId} không phải vai ${role}`);

    const socket = io({ auth: { token }, transports: ["websocket"] });
    socket.on("connect_error", (e) => handlers.onConn?.("error", e.message));
    socket.on("connect", () => handlers.onConn?.("online"));
    socket.on("disconnect", (reason) => handlers.onConn?.("offline", reason));
    socket.on("session:ready", (p) => handlers.onReady?.(p));
    // Ghi lai moi su kien nhan duoc vao nhat ky (de thay ro "minh chi nhan gi").
    socket.onAny((name, data) => handlers.onAnyEvent?.(name, data));
    return { socket, user, emit: (name, payload) => socket.timeout(5000).emitWithAck(name, payload).catch(() => ({ ok: false, error: "Hết thời gian chờ phản hồi" })) };
  }

  /** "Rut day mang" dot ngot: dong transport, khong gui goi tin chao tam biet cua Socket.IO. */
  function hardDrop(socket) {
    socket.io.engine.close();
  }

  // ---------------------------------------------------------------- ban do don gian (SVG) khu vuc Ha Noi
  const BOX = { minLat: 20.99, maxLat: 21.06, minLng: 105.78, maxLng: 105.88 };
  const xy = (p) => ({
    x: ((p.lng - BOX.minLng) / (BOX.maxLng - BOX.minLng)) * 100,
    y: (1 - (p.lat - BOX.minLat) / (BOX.maxLat - BOX.minLat)) * 100,
  });
  /** marks: [{ point, color, label, shape: "dot"|"square"|"ring" }] - diem (don) ve truoc, tai xe ve sau de nam tren; nhan don dat ben duoi de khong de nhan tai xe. */
  function drawMap(el, marks) {
    const items = marks
      .filter((m) => m.point)
      .sort((a, b) => (a.shape === "square" ? 0 : 1) - (b.shape === "square" ? 0 : 1))
      .map((m) => {
        const { x, y } = xy(m.point);
        const shape =
          m.shape === "square"
            ? `<rect x="${x - 1.6}" y="${y - 1.6}" width="3.2" height="3.2" fill="${m.color}"/>`
            : m.shape === "ring"
              ? `<circle cx="${x}" cy="${y}" r="1.8" fill="none" stroke="${m.color}" stroke-width=".8"/>`
              : `<circle cx="${x}" cy="${y}" r="1.8" fill="${m.color}" stroke="#fff" stroke-width=".4"/>`;
        const ty = m.shape === "square" ? y + 4.5 : y + 1; // nhan don nam duoi diem
        return `${shape}<text x="${x + 2.4}" y="${ty}" font-size="3" fill="currentColor">${esc(m.label)}</text>`;
      })
      .join("");
    el.innerHTML = `<svg viewBox="-2 -2 104 104" preserveAspectRatio="none">
      <rect x="-2" y="-2" width="104" height="104" fill="var(--map)"/>
      <path d="M0 50 H100 M50 0 V100" stroke="var(--grid)" stroke-width=".3"/>${items}</svg>`;
  }

  /** Di chuyen 1 buoc tu a toi b (gia lap xe chay). */
  function stepTowards(a, b, step = 0.0015) {
    const dLat = b.lat - a.lat, dLng = b.lng - a.lng;
    const dist = Math.hypot(dLat, dLng);
    if (dist <= step) return { ...b, arrived: true };
    return { lat: a.lat + (dLat / dist) * step, lng: a.lng + (dLng / dist) * step, arrived: false };
  }

  const PLACES = [
    { lat: 21.0285, lng: 105.8542, address: "Hồ Gươm, Hoàn Kiếm" },
    { lat: 21.0368, lng: 105.8345, address: "Lăng Bác, Ba Đình" },
    { lat: 21.0068, lng: 105.8431, address: "ĐH Bách Khoa, Hai Bà Trưng" },
    { lat: 21.0189, lng: 105.8165, address: "Láng Hạ, Đống Đa" },
    { lat: 21.0466, lng: 105.8008, address: "Cầu Giấy" },
    { lat: 21.0012, lng: 105.8205, address: "Royal City, Thanh Xuân" },
  ];

  function log(el, name, data) {
    const line = document.createElement("div");
    line.innerHTML = `<span class="t">${time(Date.now())}</span> <b>${esc(name)}</b> <span class="d">${esc(JSON.stringify(data)).slice(0, 220)}</span>`;
    el.prepend(line);
    while (el.childElementCount > 80) el.lastChild.remove(); // man hinh mo lau khong phinh bo nho
  }

  return { $, esc, time, ago, STATUS, connect, hardDrop, drawMap, stepTowards, PLACES, log };
})();
