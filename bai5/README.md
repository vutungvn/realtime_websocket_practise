# Bài tập 5: Vá lỗi khách hàng nhận được đơn hàng của người khác

NestJS 11 + Socket.IO 4. Repo giữ **cả bản lỗi gốc** (`order.gateway.buggy.ts`) và **bản đã vá** (`order.gateway.ts`), để chạy cùng một bộ kịch bản và đối chiếu.

```
bai5/
├─ src/order/order.gateway.ts         ← PHẦN 2: bản đã vá (file nộp)
├─ src/order/order.gateway.buggy.ts   ← bản gốc từ staging (giữ nguyên logic lỗi)
├─ src/order/order.controller.ts      ← PATCH /orders/:id/status (giả lập admin), GET /debug/state
├─ public/index.html                  ← giao diện "khách hàng" (mỗi tab = 1 khách)
├─ public/admin.html                  ← giao diện "nội bộ": cập nhật đơn, xem state server, stress test
└─ test/order.gateway.spec.ts         ← kiểm thử e2e tự động cho cả 2 bản
```

## Luồng nghiệp vụ

```
Khách (tab)                      OrderGateway                         Hệ thống nội bộ
 1. connect  ─────────────────▶  cấp socket.id
 2. emit order:track "1024" ──▶  ghi nhận: socket X theo dõi đơn 1024
                                                                     3. đơn 1024 đổi trạng thái
                                 notifyStatusChanged("1024", ...) ◀── PATCH /orders/1024/status
 4. ◀── order:updated ─────────  CHỈ gửi cho socket đang theo dõi 1024
 5. đóng tab ─────────────────▶  handleDisconnect: xoá mọi dấu vết của X
```

## Phần 1: Lỗi và kịch bản tái hiện

### Lỗi 1: `server.emit` phát cho toàn bộ client (lộ dữ liệu)
`this.server.emit(...)` gửi tới **mọi** socket. Map `tracked` được ghi nhưng không bao giờ được đọc. Mỗi tab nhận toàn bộ cập nhật đơn của cả hệ thống, nên trình duyệt chậm dần khi để tab mở lâu.

| Bước | Hành động |
|---|---|
| 1 | Tab A connect, `order:track "1024"` |
| 2 | Tab B connect, `order:track "2048"` |
| 3 | Tab C connect, không track |
| 4 | `PATCH /orders/1024/status {status:"SHIPPED"}` |

| | Tab A (1024) | Tab B (2048) | Tab C |
|---|---|---|---|
| Thực tế (bản lỗi) | nhận | **nhận** ❌ | **nhận** ❌ |
| Đúng / bản đã vá | nhận | không nhận | không nhận |

### Lỗi 2: `handleDisconnect` không dọn `tracked` (rò rỉ bộ nhớ server)
Mỗi socket đã track để lại một entry vĩnh viễn. Socket.IO cấp `id` mới mỗi lần reconnect hoặc F5, nên rác tăng còn nhanh hơn số người dùng thật.

| Bước | Hành động |
|---|---|
| 1 | Ghi lại `tracked.size` (= 0) |
| 2 | Lặp 50 lần: connect, `order:track "stress-i"`, disconnect |
| 3 | Đọc lại `tracked.size` (`GET /debug/state`) |

| | `tracked.size` sau 50 vòng |
|---|---|
| Thực tế (bản lỗi) | **50** (và tăng mãi) |
| Đúng / bản đã vá | **0**, `orderRooms = {}` |

### Lỗi 3: `Map<socketId, orderId>` ghi đè, một tab chỉ theo dõi được một đơn
Tab A track `1024` rồi `2048`. Bản lỗi lưu `tracked[A] = ["2048"]` và mất `1024`. Nếu chỉ sửa chỗ emit theo Map này thì A sẽ không còn nhận cập nhật của đơn 1024. Bản đã vá dùng `Set` và room, nên A nhận đủ cả hai.

### Vấn đề phụ (ghi nhận, ngoài phạm vi bài)
- Không kiểm tra **quyền sở hữu đơn**: ai cũng track được bất kỳ `orderId` nào (IDOR). Cần xác thực (JWT ở handshake) và kiểm tra đơn có thuộc user không.
- Không validate `orderId` (bản vá đã thêm chuẩn hoá và kiểm tra).
- `cors: { origin: "*" }` chấp nhận được ở staging; production nên giới hạn domain.

## Phần 2: Cách vá (`src/order/order.gateway.ts`)

| Chỗ sửa | Trước | Sau |
|---|---|---|
| Đăng ký theo dõi | `tracked.set(id, orderId)` | `client.join("order:<id>")` + `Set` các đơn |
| Phát sự kiện | `server.emit(...)` | `server.to("order:<id>").emit(...)` |
| Rời đi | chỉ `console.log` | `tracked.delete(client.id)`; Socket.IO tự rời mọi room |
| Bổ sung | (không có) | `order:untrack`, validate `orderId`, `implements OnGatewayDisconnect` |

## Chạy và kiểm thử

```bash
npm install
npm test                # 9 test e2e: 3 test tái hiện lỗi (bản lỗi) + 6 test bản đã vá
npm start               # chạy bản ĐÃ VÁ tại http://localhost:3000
npm run start:buggy     # chạy bản LỖI để quan sát
```

Thử bằng tay: mở `http://localhost:3000/admin.html` và nhiều tab `http://localhost:3000/?track=1024`, `/?track=2048`, ... Bấm cập nhật đơn ở trang admin rồi xem tab nào nhận. Sự kiện "không phải của mình" sẽ hiện **màu đỏ**.
