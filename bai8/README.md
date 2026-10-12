# Bài tập 8: Chọn kỹ thuật cập nhật cho bảng điều khiển vận hành

> **Quyết định: SSE (Server-Sent Events) + nhịp tim 10s + phát bù bằng `Last-Event-ID` + lớp tự phục hồi phía client.**
> Căn cứ là số liệu **đo thật** (`npm run compare`), không chỉ suy luận. Xem phần B.

```
src/server/stream.hub.ts       SSE: header, nhịp tim, phát bù Last-Event-ID / snapshot
src/server/dashboard.store.ts  trạng thái + nhật ký sự kiện (bộ đệm phát bù)
src/server/controllers.ts      /stream (SSE), /api/snapshot (polling để so sánh), /admin/* (điều khiển test)
public/reliable-sse.js         lớp tự phục hồi phía màn hình (dùng chung trình duyệt + test)
public/dashboard.html          màn hình lớn trong kho
src/tools/lb-sim.ts            bộ cân bằng tải giả lập: cắt kết nối im lặng 60s + giả lập rớt mạng kho
src/experiment/compare.ts      thí nghiệm định lượng: polling vs SSE vs SSE không nhịp tim
logs/compare.log               kết quả thí nghiệm
```

---

## A. Phân tích bài toán

### Đầu vào / đầu ra

| | Nội dung | Kiểu dữ liệu | Tần suất |
|---|---|---|---|
| **Đầu vào** (phát sinh ở server) | đơn mới (+1 đơn, +doanh thu) | `{ newOrders: number, revenue: number, lastOrderAt: number }` | ~5s/lần cao điểm, ~2 phút/lần ban đêm |
| | tồn kho vượt ngưỡng | `{ alertId, sku, name, qty: number, level: "low" \| "out", createdAt: number }` | thất thường |
| **Đầu ra** (tới 40 màn hình) | số đơn, doanh thu, danh sách cảnh báo | sự kiện SSE `snapshot` / `metrics` / `stock-alert` / `stock-cleared` / `heartbeat` | ngay khi phát sinh |
| **Chiều ngược lại** | **không có**: màn hình không gửi gì lên | | |

### Đặc điểm quan trọng nhất của luồng dữ liệu
1. **Một chiều tuyệt đối** (server → màn hình). Mọi kỹ thuật có kênh gửi lên đều là thừa.
2. **Thưa và không đều**: 5s/lần lúc cao điểm, **hàng giờ không có gì** lúc đêm. Kỹ thuật nào hỏi theo chu kỳ cố định sẽ tốn phần lớn công sức để hỏi những câu có sẵn đáp án "không có gì mới".
3. **Có hai loại dữ liệu khác bản chất:**
   - *Số liệu* (đơn, doanh thu) là **trạng thái**: chỉ cần giá trị mới nhất, có thể gộp nhiều lần cập nhật thành một.
   - *Cảnh báo hết hàng* là **sự kiện**: từng cái đều quan trọng, có hạn chót 10s, và **không được mất** kể cả khi màn hình đang rớt mạng.
4. **Không có người thao tác**: màn hình phải tự phục hồi, và **không bao giờ được hiển thị số liệu cũ mà không cảnh báo**.
5. **Đi qua bộ cân bằng tải cắt kết nối im lặng 60s**: kết nối dài nào im lặng (ban đêm) sẽ bị cắt nếu không có cơ chế giữ sống.

### Các giải pháp khả thi

**(a) Polling theo chu kỳ (có ETag).** Màn hình gọi `GET /api/snapshot` mỗi 5s. Không đổi thì server trả `304` (thân rỗng).
Muốn đạt hạn 10s thì chu kỳ phải ≤ ~9s; chọn 5s để có dư địa.

**(a′) Long-polling.** Server giữ request tới khi có dữ liệu hoặc tối đa ~50s (< 60s của LB) rồi trả rỗng, client gọi lại ngay. Độ trễ thấp, nhưng phải tự làm cơ chế con trỏ để không mất sự kiện giữa hai lần gọi, tức là tự viết lại những gì SSE đã có sẵn.

**(b) Luồng sự kiện một chiều: SSE.** Một request HTTP `GET /stream` được giữ mở, server đẩy từng sự kiện dạng text. Trình duyệt có sẵn `EventSource`, **tự kết nối lại** và **tự gửi `Last-Event-ID`** để server phát bù.

**(c) Song công đầy đủ: WebSocket (Socket.IO).** Kênh hai chiều qua giao thức Upgrade, Socket.IO lo ping/pong và tự nối lại.

---

## B. So sánh và lựa chọn

### Số liệu đo được
Chạy `npm run compare`: 40 màn hình mỗi giải pháp, cùng một server, mỗi giải pháp đi qua một bộ cân bằng tải giả lập riêng để đếm byte. Thời gian thu nhỏ 10 lần, kết quả đã quy về thời gian thật.

| Pha | Polling 5s (ETag) | SSE + nhịp tim 10s | SSE **không** nhịp tim |
|---|---|---|---|
| Cao điểm 5 phút: số request | **2.439** | 0 (giữ 40 kết nối) | |
| Cao điểm: tải xuống | 967 KB | 412 KB | |
| Độ trễ cảnh báo (TB / tối đa) | **1,6s / 4,7s** | **5ms / 8ms** | |
| Ban đêm 5 phút, 0 thay đổi: request | 2.337 (gần như toàn `304` vô ích), ~**673.000 request/ngày** | 0 | |
| Ban đêm: số lần LB cắt kết nối | 0 (request ngắn) | **0** | **160 lần / 5 phút** (~46.000 lần/ngày) |
| Ban đêm: băng thông | 420 KB (~121 MB/ngày) | 52 KB nhịp tim (~**14,5 MB/ngày**) | |
| Rớt mạng 90s: cảnh báo tới đủ | 80/80 | **80/80**, không trùng | |
| Thời gian hồi phục sau khi có mạng | 5,6s | **2,0s** (phát bù qua `Last-Event-ID`, 0 snapshot) | |

### Bảng so sánh theo tiêu chí

| Tiêu chí | (a) Polling 5s | (b) SSE + nhịp tim | (c) WebSocket |
|---|---|---|---|
| **1. Độ trễ** | Trung bình bằng nửa chu kỳ (đo được 1,6s), xấu nhất bằng một chu kỳ (4,7s). Đạt hạn 10s, nhưng phải đánh đổi bằng số request. | Đẩy ngay: **5–8ms**. Đạt hạn 10s với dư địa gấp ~1000 lần. | Như SSE (vài ms). |
| **2. Kết nối và tài nguyên server** | 0 kết nối giữ lâu, nhưng **~691.000 request/ngày** (40 × 86.400/5). Mỗi request đều qua LB, xác thực, routing. Ban đêm **gần như toàn bộ là 304 vô ích** (đo: 2.337 request / 5 phút khi không có thay đổi nào). ~180–200 MB/ngày. | **40 kết nối giữ mở** (vài KB RAM mỗi kết nối). Request/ngày ≈ 40 + số lần nối lại. Ban đêm chỉ tốn nhịp tim, ~14,5 MB/ngày. | 40 kết nối như SSE, cộng thêm ping/pong hai chiều và bộ đệm của Socket.IO. |
| **3. Ràng buộc LB 60s** | **Không ảnh hưởng**: mỗi request kết thúc trong vài ms. | **Bị ảnh hưởng nếu im lặng**: không nhịp tim thì LB cắt **~46.000 lần/ngày**, mỗi lần để lại một khoảng mù. Nhịp tim 10s thì **0 lần cắt** (đã đo). | Socket.IO ping mặc định 25s < 60s nên tự sống qua LB, *nhưng* LB phải hỗ trợ `Upgrade`, và cần sticky session nếu rơi về long-polling. |
| **4. Tự phục hồi khi rớt mạng** | Tự nhiên: lần poll sau chạy lại. Nhưng chỉ thấy **trạng thái hiện tại**: cảnh báo phát sinh rồi được gỡ trong lúc rớt mạng sẽ **mất hẳn**. | `EventSource` tự nối lại và tự gửi `Last-Event-ID`, server **phát bù đúng sự kiện bị lỡ**. Còn 3 lỗ hổng (HTTP 5xx làm trình duyệt bỏ cuộc, kết nối half-open, thời gian thử lại tuỳ trình duyệt), được vá bằng `reliable-sse.js`. | Socket.IO tự nối lại; phát bù cần bật `connectionStateRecovery` (có giới hạn thời gian) hoặc tự làm. |
| **5. Độ phức tạp triển khai và vận hành** | **Thấp nhất**: một API GET + ETag. Debug bằng trình duyệt. | Thấp–vừa: HTTP thuần, không thư viện phía client, xem được bằng `curl` hoặc tab EventStream của DevTools. Cần nhớ: tắt buffer/nén ở proxy (`X-Accel-Buffering: no`, `no-transform`). | **Cao nhất**: giao thức riêng, thư viện ~40KB ở client, LB phải cấu hình Upgrade, khó debug bằng công cụ HTTP. Toàn bộ chiều client → server là **thừa**. |
| **Khớp với "một chiều"** | Có, nhưng là *kéo* chứ không *đẩy*. | **Khớp đúng**: SSE sinh ra cho luồng server → client. | Không: trả giá cho hai chiều mà chỉ dùng một. |

### Chốt: SSE + nhịp tim

Biện luận theo 3 ràng buộc nghiệp vụ:

1. **Cảnh báo ≤ 10s.** SSE đẩy trong ~5ms. Polling chỉ đạt khi chu kỳ ≤ 9s, và mỗi giây rút ngắn chu kỳ lại tăng số request tương ứng.
2. **Chạy 24/7 không người, ban đêm yên tĩnh hàng giờ.**
   - Polling vẫn gửi **~691.000 request/ngày bất kể có dữ liệu hay không**; ban đêm gần như toàn bộ là `304` vô ích.
   - SSE chỉ tốn đúng những gì thay đổi, cộng nhịp tim **~14,5 MB/ngày**.
   - Màn hình biết phân biệt "không có thay đổi nhưng kết nối vẫn sống" với "đã mất kết nối", và hiện banner đỏ khi số liệu có thể đã cũ.
3. **Bộ cân bằng tải cắt kết nối im lặng sau 60s.** Đây là ràng buộc *chống lại* SSE: một kết nối im lặng cả đêm sẽ bị cắt mỗi phút. **Đo được: 160 lần cắt / 5 phút với 40 màn hình**.
   - Cách giải: server gửi `event: heartbeat` **mỗi 10s**, nên LB luôn thấy có byte đi qua và **0 lần cắt**.
   - Vì sao 10s mà không phải 55s: dư địa gấp 6 lần, nên mất 5 nhịp tim liên tiếp vẫn sống. Watchdog phía client phát hiện kết nối chết trong ~25s. Chi phí gần như bằng 0.
   - Nhịp tim là sự kiện có tên chứ không phải comment `:`, vì comment thì JavaScript phía trình duyệt **không nhìn thấy**, nên watchdog không dùng được.

Polling **đạt** cả 3 ràng buộc và đơn giản hơn, nên đây là phương án dự phòng chấp nhận được (đã cài sẵn ở `?mode=poll`). SSE thắng vì cùng đạt hạn 10s nhưng **ít hơn ~17.000 lần số request**, độ trễ thấp hơn ~300 lần, và **không mất cảnh báo ngắn hạn** nhờ phát bù theo sự kiện.

---

## C. Thiết kế và triển khai

### Các bước thực hiện

```mermaid
sequenceDiagram
    participant M as Màn hình kho (ReliableStream)
    participant LB as Bộ cân bằng tải (idle 60s)
    participant S as Server (StreamHub)
    M->>LB: GET /stream (Accept: text/event-stream)
    LB->>S: chuyển tiếp
    S-->>M: 200, retry: 2000 + event: snapshot (id: boot-42)
    loop mỗi 10s, kể cả ban đêm
        S-->>M: event: heartbeat  (LB thấy byte → không cắt; watchdog reset)
    end
    Note over S: tồn kho = 0
    S-->>M: id: boot-43, event: stock-alert (vài ms)
    Note over M,LB: mạng kho rớt 90s
    M-xLB: quá 25s im lặng → watchdog: đóng, thử lại mỗi ~2s
    Note over M,LB: mạng hồi phục
    M->>LB: GET /stream?lastEventId=boot-43
    S-->>M: phát bù boot-44, boot-45 (chỉ đúng những gì bị lỡ)
```

1. **Server mở luồng** (`stream.hub.ts`):
   - Gửi header `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no` để proxy không gom hoặc nén mất sự kiện.
   - Gửi `retry: 2000`.
2. **Gửi trạng thái đầu**:
   - Không có `Last-Event-ID` → gửi `snapshot`.
   - Có `Last-Event-ID` và còn nằm trong bộ đệm 1.000 sự kiện → **phát bù đúng phần bị lỡ**.
   - Id thuộc lần khởi động trước (server restart, `bootId` khác) hoặc đã quá cũ → gửi `snapshot`. Không bao giờ phát bù sai.
3. **Phát sự kiện**:
   - Cảnh báo được phát **ngay** và không gộp.
   - Số liệu được **gộp tối đa 1 lần/giây**, luôn mang giá trị mới nhất (giờ cao điểm 100 đơn cùng lúc chỉ thành 1–2 sự kiện).
4. **Nhịp tim mỗi 10s** (< 60s của LB), đi kèm mỗi kết nối và dọn sạch khi màn hình ngắt.
5. **Màn hình** (`reliable-sse.js`) tự quản lý việc nối lại theo 3 chính sách:
   - *Lỗi mạng* → thử lại sau ~2s (có jitter): mạng có lại là lên ngay.
   - *Server trả HTTP lỗi* (503 bảo trì, 502 deploy) → backoff 1s → 2s → … → 10s. Riêng trường hợp này `EventSource` gốc sẽ **bỏ cuộc vĩnh viễn** nếu không có lớp bọc.
   - *Im lặng quá 25s* (kết nối half-open) → đóng rồi nối lại.
   - Mỗi lần nối lại đều gửi `?lastEventId=` để được phát bù.
6. **Hiển thị trung thực**: mất kết nối ≥10s **hoặc** quá 2 nhịp tim không nghe gì → banner đỏ "SỐ LIỆU CÓ THỂ ĐÃ CŨ". Ban đêm yên tĩnh → "không có thay đổi nhưng kết nối vẫn sống".

### Xử lý 2 bẫy dữ liệu

| Bẫy | Xảy ra gì nếu không xử lý | Cách xử lý | Test |
|---|---|---|---|
| **Ban đêm hàng giờ không thay đổi** | Kết nối SSE im lặng, LB cắt mỗi 60s → ~46.000 lần nối lại/ngày, khoảng mù sau mỗi lần cắt; màn hình không phân biệt được "yên tĩnh" với "chết". | Nhịp tim 10s (0 lần cắt) + watchdog 25s + dòng trạng thái "nhịp tim Xs trước". | TC4, TC5 |
| **Mạng kho rớt vài giây** | Rớt ngắn: không sao. Rớt lâu hơn ngưỡng LB: kết nối chết, cảnh báo phát sinh lúc rớt bị mất; server bảo trì trả 503 thì `EventSource` bỏ cuộc vĩnh viễn. | Rớt ngắn: TCP tự giữ, **không cần nối lại** (TC6). Rớt lâu: thử lại ~2s + phát bù `Last-Event-ID` (TC7). Quá lâu hoặc server restart: snapshot (TC9, TC10). 503: backoff tới khi được (TC8). | TC6–TC10 |

### Cấu hình

| Tham số | Giá trị | Lý do |
|---|---|---|
| `HEARTBEAT_MS` | 10.000 | < 60s của LB với dư địa gấp 6 lần |
| watchdog (client) | 25.000 | 2,5 nhịp tim: chịu được 1–2 nhịp trễ, phát hiện kết nối chết sớm |
| `SSE_RETRY_MS` | 2.000 | thời gian hồi phục sau khi mạng có lại |
| backoff khi HTTP lỗi | 1s → 10s | 40 màn hình × 1 lần/10s = 4 req/s lúc tệ nhất |
| `METRICS_THROTTLE_MS` | 1.000 | số liệu chỉ cần mới nhất |
| `REPLAY_BUFFER` | 1.000 sự kiện | ≈ 80 phút cao điểm; quá thì gửi snapshot |

---

## Chạy và kiểm thử

```bash
npm install
npm test          # 11 test nghiệp vụ end-to-end (thời gian thu nhỏ 60 lần)
npm run compare   # thí nghiệm định lượng (~75s) → logs/compare.log
```

### Test tay
Mở **3 terminal** trong `bai8/`:
```powershell
npm run server                  # T1: server :4000, giả lập giờ cao điểm
npm run lb                      # T2: bộ cân bằng tải :8080 (cắt sau 60s im lặng), gõ lệnh ở đây
```
Mở trình duyệt:
- **Màn hình kho (qua LB):** `http://localhost:8080/dashboard.html`
- **Bảng điều khiển test (thẳng server):** `http://localhost:4000/admin.html`
- Mẹo: nhấn F12, vào **Network**, chọn request `stream`, mở tab **EventStream** để xem từng sự kiện SSE.

| # | Nghiệp vụ cần kiểm | Thao tác | Kết quả đúng |
|---|---|---|---|
| M1 | Dữ liệu một chiều, cập nhật ngay | admin: **+1 đơn** | Số đơn và doanh thu đổi < 1s; EventStream có `metrics` |
| M2 | Cảnh báo ≤ 10s | admin: **Hết hàng (0)** ở 1 SKU | Ô đỏ "HẾT HÀNG…", dòng "tới màn hình sau Xms" |
| M3 | Số liệu gộp, cảnh báo không gộp | admin: **+10 đơn liên tiếp** | EventStream chỉ có 1–2 `metrics`, con số cuối đúng +10 |
| M4 | **Ràng buộc 60s, ban đêm** | admin: **Tắt mô phỏng**, chờ ≥ 3 phút | "Số lần nối lại: 0", "Nhịp tim gần nhất: ≤10s trước"; T2 gõ `s` thấy `idleKills: 0` |
| M5 | Đối chứng: không nhịp tim | mở `dashboard.html?hb=0`, chờ 3 phút | T2 in "im lặng 60s → LB ĐÓNG KẾT NỐI" mỗi phút; "Số lần nối lại" tăng dần |
| M6 | Rớt mạng **ngắn** | T2 gõ `o 5`, trong 5s đó bấm **Hết hàng** một SKU khác | Hết 5s, cảnh báo hiện ra; "Số lần nối lại" **không tăng** (kết nối cũ sống qua) |
| M7 | Rớt mạng **lâu** | T2 gõ `d`, chờ ~30s (banner đỏ hiện), bấm **Hết hàng**, gõ `u` | Banner tắt sau ≤ 2s, cảnh báo phát sinh lúc rớt **vẫn hiện**; T1 in "NỐI LẠI từ …: phát bù N sự kiện" |
| M8 | Server bảo trì (503) | admin: **Bật bảo trì**, T2 gõ `r`, chờ 10s, **Tắt bảo trì** | Màn hình "Mất kết nối" rồi tự lên lại trong ≤ 10s, không ai bấm F5 |
| M9 | Server khởi động lại | T1: Ctrl+C rồi `npm run server` | Màn hình nhận `snapshot` mới (số reset theo server mới), không phát bù sai |
| M10 | So sánh polling | mở `dashboard.html?mode=poll` | Cập nhật chậm hơn (≤ 5s); admin thấy `pollRequests` tăng đều cả khi không có gì đổi |

Muốn xem nhanh ràng buộc 60s mà không phải chờ, thu nhỏ thời gian:
```powershell
$env:HEARTBEAT_MS=3000; $env:SIM_MODE="off"; npm run server     # T1
$env:LB_IDLE_MS=10000; npm run lb                                # T2: LB cắt sau 10s
```

## Giới hạn đã biết
- Trạng thái và bộ đệm phát bù nằm trong RAM của một server. Chạy nhiều server thì cần Redis Pub/Sub và bộ đệm dùng chung, hoặc sticky session.
- HTTP/1.1 giới hạn ~6 kết nối mỗi tên miền trên một trình duyệt. Một tab mỗi màn hình thì không sao; nhiều tab thì dùng HTTP/2.
- Watchdog 25s nghĩa là với kết nối "chết im lặng" (half-open), cảnh báo có thể tới trễ ~25s. Banner đỏ báo sớm hơn, sau ~22s, để nhân viên biết số liệu không còn tin cậy.
