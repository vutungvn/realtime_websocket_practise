# Bài tập 6: Cơ chế kết nối lại cho ứng dụng tài xế ShopFast

NestJS 11 + Socket.IO 4. Mạng di động được giả lập bằng một proxy TCP (`ChaosProxy`) đặt giữa app tài xế và server, nên có thể "đi vào hầm" theo ý muốn.

```
app tài xế ──▶ ChaosProxy :4100 (mất mạng / chập chờn) ──▶ server :4000
                                                           ▲
                                     trang vận hành /ops.html (nối thẳng)
```

| File | Nội dung |
|---|---|
| `src/client/driver-client.ts` | **Chỗ khuyết (1) (2) (3) (4)** |
| `src/server/driver.gateway.ts`, `src/server/config.ts` | **Chỗ khuyết (5)**, middleware xác thực + rate limit |
| `src/server/presence.service.ts` | Trạng thái tài xế: online → đang chờ nối lại → offline |
| `src/server/order.store.ts` | Lưu đơn gần đây để bù đơn bị lỡ khi nối lại |
| `src/tools/chaos-proxy.ts` | Mạng giả lập: `cut()` vào hầm, `restore()` ra hầm, `dropAll()` cắt ngang |
| `public/driver.html` | Màn hình tài xế (bản trình duyệt, có banner trạng thái) |
| `public/ops.html` | Màn hình vận hành: tạo đơn, xem tài xế online/offline |
| `logs/outage-demo.log` | **Log nộp bài**: mất mạng 15s, nối lại, tắt hẳn app |
| `logs/flap-demo.log` | Log bẫy dữ liệu: chập chờn 10 lần / 30s, 50 tài xế |

## Vòng đời kết nối

```
          connect + driver:subscribe
 [mở app] ───────────────────────────▶ [ONLINE] ◀──────────────────────────────┐
                                          │ mất sóng: không còn ping/pong       │ (3) connect → đăng ký lại room
                                          ▼ phát hiện sau ≤ pingInterval+Timeout │     + bù đơn bị lỡ
                                    [MẤT KẾT NỐI] ── (4) banner đỏ cho tài xế    │
                                          │ (1)(2) chờ 1s, 2s, 4s… ±50% rồi thử ─┘
                                          ▼ hết 15 lần
                                 [CHỜ MẠNG] thử lại mỗi 60s, không bắt tài xế làm gì

 Phía server: mất socket cuối → ĐANG CHỜ NỐI LẠI ──(5s ân hạn)──▶ OFFLINE
```

## Lời giải 5 chỗ khuyết

```ts
const socket = io(SERVER_URL, {
  auth: { token },
  transports: ["websocket"],
  // (1) tự động kết nối lại
  reconnection: true,
  // (2) giới hạn số lần + độ trễ giãn dần + jitter
  reconnectionAttempts: 15,
  reconnectionDelay: 1_000,      // lần đầu ~1s
  reconnectionDelayMax: 30_000,  // trần 30s
  randomizationFactor: 0.5,      // ±50% ngẫu nhiên
  timeout: 5_000,                // mỗi lần thử tối đa 5s
});

socket.on("order:new", showOrder);             // đăng ký 1 LẦN, ngoài "connect"

socket.on("connect", async () => {
  // (3) socket mới trên server không còn room nào → xin lại + bù đơn bị lỡ
  const res = await socket.timeout(5000).emitWithAck("driver:subscribe", { zones, sinceSeq });
  res.missed.forEach(showOrder);
});

// (4) báo cho tài xế
socket.on("disconnect", (reason) => {
  showBanner("Mất kết nối – đang thử lại...");
  if (reason === "io server disconnect") socket.connect(); // trường hợp duy nhất Socket.IO không tự nối lại
});
socket.io.on("reconnect_attempt", (n) => showBanner(`Đang thử lại lần ${n}/15...`));
socket.io.on("reconnect_failed", () => setTimeout(() => socket.connect(), 60_000));
socket.on("connect_error", (err) => { if (!socket.active) /* bị server từ chối: token / rate limit */ });

// --- phía server ---
@WebSocketGateway({
  // (5) ngưỡng chờ trước khi coi là mất kết nối
  pingInterval: 10_000, // server gửi ping mỗi 10s
  pingTimeout: 5_000,   // không có pong trong 5s → coi là chết (tối đa ~15s)
})
```

### Giải thích từng chỗ

**(1) `reconnection: true`.** Socket.IO bật sẵn tuỳ chọn này, nhưng ghi rõ ra để thể hiện ý định. Tuỳ chọn này chỉ xử lý các lần rớt *ngoài ý muốn* (`ping timeout`, `transport close`, `transport error`). Nếu server chủ động `disconnect()` thì client **không** tự nối lại. Đó là lý do (4) có nhánh `io server disconnect`.

**(2) Giới hạn và giãn dần.** Độ trễ trước lần thử thứ n là `min(1s × 2^(n-1), 30s)`, cộng hoặc trừ ngẫu nhiên tới 50%:

| Lần thử | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| Độ trễ danh nghĩa | 1s | 2s | 4s | 8s | 16s | 30s |
| Khoảng thực tế (jitter 0.5) | 0.5–1.5s | 1–3s | 2–6s | 4–12s | 8–24s | 15–30s |

- Giãn dần giúp máy không thử dồn dập lúc đang mất sóng, vì thử lúc này chắc chắn thất bại.
- Jitter giúp hàng nghìn tài xế ra khỏi hầm hoặc chờ server khởi động lại không cùng bắn request vào một thời điểm (thundering herd).
- Giới hạn 15 lần (khoảng 5–6 phút) rồi chuyển sang thử lại mỗi 60s, chứ **không bỏ cuộc**: tài xế không phải tắt mở app.
- `timeout: 5000`: mặc định là 20s, quá lâu trên mạng di động.

**(3) Đăng ký lại room.** Room thuộc về *socket*, không thuộc về *tài xế*. Mỗi lần nối lại, server tạo socket mới với id mới và không có room nào, nên sẽ không nhận được đơn. Client giữ danh sách khu vực mong muốn và gửi lại mỗi khi có `connect`. Server đặt lại tập room đúng bằng danh sách đó, nên gọi bao nhiêu lần cũng cho cùng một kết quả. Room cá nhân `driver:<id>` thì server tự join dựa trên token.
Bổ sung: client gửi kèm `sinceSeq` (số thứ tự đơn cuối đã đồng bộ), server trả lại các đơn bị lỡ trong lúc mất mạng. Log demo cho thấy **0 đơn bị mất**.
Lỗi hay gặp: đặt `socket.on("order:new")` *bên trong* `connect`. Mỗi lần nối lại sẽ thêm một listener, nên một đơn hiện N lần. Test TC6 kiểm tra điều này.

**(4) Báo cho tài xế.** Mỗi sự kiện vòng đời tương ứng với một banner trên màn hình:

| Sự kiện | Ý nghĩa | Banner |
|---|---|---|
| `disconnect` | vừa mất kết nối | 🟠 Mất kết nối – đang thử lại |
| `io.reconnect_attempt` | đang thử lần n | 🟠 Đang thử lại lần n/15 |
| `io.reconnect_failed` | hết 15 lần | 🔴 Không có kết nối, tự thử sau 60s |
| `connect_error` + `!socket.active` | server từ chối (token, rate limit) | 🔴 Đăng nhập lại / chờ |
| `connect` + subscribe xong | sẵn sàng | 🟢 Đang trực tuyến |

**(5) Ngưỡng phía server.** Server gửi `ping` sau mỗi `pingInterval`. Nếu client không trả `pong` trong `pingTimeout` thì server ngắt với lý do `ping timeout`. Điện thoại hết pin trong hầm không kịp gửi gói đóng kết nối, nên heartbeat là cách **duy nhất** để server biết.
- Mặc định của Socket.IO là 25s + 20s = **45s**. Như vậy tài xế đã tắt máy vẫn "online" gần một phút, khớp với phản ánh của đội vận hành.
- Chọn 10s + 5s, tức phát hiện trong ≤ 15s. Nếu đặt thấp hơn nhiều, mạng 3G hơi lag cũng bị tính là rớt, dẫn tới nối lại vô ích.
- Thêm **ân hạn 5s** ở `PresenceService`: mất socket cuối cùng thì chuyển sang "đang chờ nối lại", 5s sau mới chuyển OFFLINE. Rớt 1–2 giây rồi nối lại ngay sẽ không làm trạng thái nhảy qua lại (test TC5).
- Phía client cũng dùng cùng ngưỡng này: không nhận được ping trong 15s thì client tự đóng và bắt đầu thử lại.

## Bẫy dữ liệu: mạng chập chờn 10 lần / 30s

`npm run demo:flap`: 50 tài xế, mỗi chu kỳ gồm cắt ngang kết nối, mất sóng 1.5s, có sóng 1.5s, lặp 10 lần.

| | Cấu hình đúng | Sai: cố định 100ms, không jitter, vô hạn |
|---|---|---|
| Số lần thử kết nối từ 50 máy | **549** (~11/máy) | 6670 (~133/máy), **gấp 12 lần** |
| Đỉnh trong 100ms | **8** | 50: cả 50 máy bắn cùng lúc |
| Mỗi tài xế nhận đơn đúng 1 lần | ✅ | ✅ |
| Thời gian tất cả online lại sau đợt cuối | 17.4s | ~0s |

Các lớp chống bão:
1. **Backoff theo hàm mũ**: thử thưa dần khi mạng vẫn chưa ổn.
2. **Jitter**: dàn đều các máy ra, không để chúng dồn thành một đỉnh.
3. **Giới hạn số lần + thử chậm 60s**: một máy hỏng mạng cả ngày không thể spam vô hạn.
4. **`transports: ["websocket"]`**: mỗi lần nối lại chỉ cần 1 request thay vì chuỗi long-polling.
5. **Rate limit ở server** (20 lần bắt tay / phút / tài xế): lớp bảo vệ cuối trước client lỗi hoặc client độc hại. Client nhận `retryAfterMs` và chờ đúng thời gian đó (TC7).

**Đánh đổi**: backoff làm tài xế có thể chờ thêm tối đa bằng mức trễ hiện tại (≤ 30s) sau khi mạng đã ổn. Bản `driver.html` bù lại bằng cách nghe sự kiện `online` của hệ điều hành để thử lại ngay khi có mạng.

## Chạy và kiểm thử

```bash
npm install
npm test               # 9 test e2e (thời gian rút ngắn: ping 300ms)
npm run demo:outage    # mất mạng 15s → nối lại → tắt hẳn app; ghi logs/outage-demo.log
npm run demo:flap      # bẫy dữ liệu, ghi logs/flap-demo.log
```

Chạy tay với 3 terminal:
```bash
npm run server         # :4000, trang vận hành http://localhost:4000/ops.html
npm run proxy          # :4100, gõ: o 15 (mất mạng 15s) | d | u | r | f (chập chờn)
npm run driver         # app tài xế trong terminal, hoặc mở http://localhost:4100/driver.html
```

## Giới hạn đã biết
- Danh sách đơn gần đây, presence và rate limit lưu trong bộ nhớ của một server. Chạy nhiều instance thì cần Redis (Socket.IO Redis adapter + lưu presence/đơn trong Redis).
- Token chỉ là giả lập (`tok_<driverId>`); thực tế phải dùng JWT.
- Socket.IO ≥ 4.6 có `connectionStateRecovery`, tự khôi phục room và gói tin bị lỡ nếu nối lại trong một khoảng ngắn. Bài này vẫn tự đăng ký lại room ở (3), vì cách đó vẫn chạy được khi server khởi động lại hoặc khi mất kết nối lâu.
