# Tối ưu: độ trễ giọng nói, tay và camera, token

Ngày 2026-11-20. Điều phối: open-iris-po.

Mục tiêu sản phẩm là bỏ bàn phím và chuột, thay bằng giọng nói và tay, nên tối ưu nhắm vào cảm giác "nói là chạy" và "tay là trỏ".

## Quy tắc chung

- **Đo trước, sửa sau.** Mỗi nhánh làm bước 0 (đo nền) và ghi số vào §4 trước khi đổi code. Mỗi thay đổi phải có số trước và sau.
- **Đo bằng log, không thêm UI.** Ghi vào `~/.open-iris/logs/main.log` với tiền tố `[perf]`. Thay đổi UI vẫn phải có bản xem trước HTML.
- Mỗi thay đổi logic có test. Shortcut có giới hạn thì ghi chú `shortcut:`.
- Không gửi màn hình terminal cho Gemini. Không commit nếu chưa có lệnh.
- Không làm hỏng các tính năng đang có: công tắc riêng, "Giữ phiên dài", nút Làm mới, ô nhập, cửa sổ camera.

## 1. Độ trễ giọng nói (open-iris-dev2)

Đo nền:

- **V1:** từ lúc người dùng ngừng nói (cuối audio gửi lên, hoặc lúc server báo hết lượt) đến gói audio đầu tiên của Iris.
- **V2:** từ `toolCall` đến lúc gửi `toolResponse`, tách theo từng tool desktop.
- **V3:** từ lúc bấm Start đến lúc `setupComplete`, và thời gian nối lại khi rớt mạng.
- Ghi p50 và p95 trên ít nhất 20 lượt, cho từng model trong `MODELS`.

Hướng cần xem, chỉ làm sau khi có số:

- Cỡ và nhịp chunk audio từ mic. Cấu hình VAD hay `realtimeInputConfig` nếu tài liệu Live có hỗ trợ.
- Bộ đệm phát audio ở renderer.
- Tool desktop chậm: lần chạy agent-desktop đầu tiên, gọi tuần tự, timeout.
- `thinkingLevel` của model extended-thinking (đã gỡ model, xem §4).

## 2. Tay và camera (open-iris-dev)

Đo nền:

- **H1:** FPS của camera và FPS của MediaPipe, ở 3 trạng thái: HUD tắt, HUD bật, cửa sổ camera mở.
- **H2:** CPU và GPU của từng process Electron trong cùng 3 trạng thái (Activity Monitor hoặc `app.getAppMetrics()`).
- **H3:** độ trễ từ khung hình đến lúc con trỏ di chuyển, và độ rung khi giữ tay yên.

Hướng cần xem:

- Độ phân giải và delegate (GPU hay CPU) của MediaPipe. Bỏ khung khi xử lý không kịp.
- Không chạy suy luận hai lần khi HUD và cửa sổ camera cùng mở.
- Bộ lọc làm mượt (`smooth`): cân bằng giữa trễ và rung. Thay đổi phải giữ test `hand.test.mjs`.

## 3. Token và chi phí (open-iris-plugins-dev)

Đo nền:

- **T1:** cỡ setup (system instruction, persona, skills, mô tả tool) tính bằng token khi bật tất cả và khi dùng mặc định. Dùng `promptTokenCount` của lượt đầu, hoặc API countTokens.
- **T2:** token tăng mỗi phút với giọng nói thuần, và mỗi ảnh gửi từ gallery hay ô nhập.
- **T3:** phần nào trong setup lớn nhất, gồm `DESKTOP_BRIEF`, mô tả tool, skills và brief của plugin.

Hướng cần xem:

- Rút gọn mô tả tool và brief mà không đổi hành vi. Kiểm tra bằng các test hiện có của `live-config` và `desktop`.
- Thu nhỏ ảnh trước khi gửi (gallery, ô nhập) nếu ảnh to hơn mức model cần.
- Chỉ gửi mô tả tool đang bật. Kiểm tra lại xem điều này đã đúng chưa.

## 4. Kết quả đo

| Mã | Nền | Sau | Thay đổi |
|---|---|---|---|
| V1 | p50/p95 (40 lượt mỗi model): 3.8-live 1173/1295 ms · 3.8-extended-thinking 1182/1318 · 3.1-flash 1323/1403. Đo từ lúc gửi xong câu nói đến gói audio đầu tiên, chưa tính mic và bộ đệm phát | | |
| V2 | Tool chỉ đọc, chạy trên Calculator, 20 lần: list_running_apps 32/36 ms; scan/find/read 136/~150 ms; lần scan đầu tiên của một app 2295 ms | Tool mới (2026-11-21, iris-desktop, thử trên TextEdit): scroll_app_view 81–104 ms; close_app 136 ms khi không có tệp chưa lưu, khoảng 5 s rồi TIMEOUT khi đang mở hộp thoại lưu (tool trả về DIALOG_OPEN) | Thêm close_app, scroll_app_view (`66e6e14`) |
| V3 | Từ connect đến setupComplete, p50/p95 (20 lần mỗi model): 3.8-live 638/695 ms · extended-thinking 695/783 · 3.1-flash 484/574. Riêng bắt tay WebSocket mất khoảng 190 ms | | |
| A0 | Thông báo hệ thống, tạo câu bằng phiên Live riêng (2026-11-21, iris-core, giọng Zephyr, 3 lượt × 6 câu): 3.8-live khớp chữ 18/18 ngay lần đầu, connect → audio cuối trung vị 1152 ms (1010–1644), dài 1,87 s; 3.1-flash 18/18 sau tối đa 2 lần thử (2 lần lặp đều ở "Hand Task Vision enabled"), 1378 ms (1218–6814, một lần ngoại lệ), dài 1,90 s. Tạo đủ 6 câu khoảng 7–9 s mỗi model. Độ dài có cả khoảng lặng đầu/cuối. Thử vọng tiếng mic: chưa chạy | | `docs/system-announce-plan.md` |
| H1 | | | |
| H2 | | | |
| H3 | | | |
| T1 | gemini-3.8-live, `promptTokenCount` lượt đầu ("Say OK."): tối thiểu 557 (phần cố định của server); mặc định 2194 (+1637); tắt hết tool 655 (+98); bật hết (3 skill, ghi chú, livestream) 2545 (+1988). Riêng 9 tool desktop + DESKTOP_BRIEF là **1539**, gần hết phần của mình | 2026-11-21, iris-desktop, cùng cách đo (tool desktop mặc định trừ tắt hết): 11 tool lúc chưa cắt gọn 2201 (+662); sau khi cắt gọn **2126 (+587)** | +587 token mỗi phiên cho close_app, scroll_app_view, surface, window_id (`66e6e14`) |
| T2 | Giọng: 15,5 s nói + 2 s im → +444 AUDIO, khoảng 25 token/s, tức khoảng 1,5k/phút (docs ghi 32/s). Ảnh composer: 256 token (64², 768²), 264 (1920×1080), 266 (4000×3000), nên thu nhỏ ảnh không bớt token. Ảnh gallery: 0 token ảnh, chỉ dòng `[gallery]` | | |
| T3 | Đếm ký tự: system text mặc định 2534 (DESKTOP_BRIEF 1795); khai báo tool 4177 (scan_app_controls 481, press_key_combo 650, type_into_text_field 539, find_app_control 403, click_app_control 406); use_skill thêm cho mỗi skill; brief livestream: SessionStart 454, recap 155, cta 246 | | |

Ghi chú đo nền giọng nói (2026-11-20, open-iris-dev2):

- Cách đo: `scripts/spikes/live-latency.mjs` (không track). Script lấy giọng từ `say` của macOS, gửi theo nhịp thật bằng các khung 8 ms giống app, với setup của app (bật hết tool desktop, bật "Giữ phiên dài"). Tóm tắt kết quả bằng `scripts/spikes/lat-summary.mjs`. V2 đo bằng `scripts/spikes/tool-latency.mjs`.
- Trong app, `main.log` có các dòng `[perf] V1/V2/V3` để so với số đo khi người dùng nói thật.
- `gemini-3.8-live-extended-thinking` đóng phiên với lỗi 1007 "BLOCKING function calls are not supported for this model" khi có tool được bật. Bỏ `behavior` thì mở được phiên, nhưng khi user thử trong app, model không bao giờ gọi tool. **User quyết định 2026-11-20:** gỡ model này khỏi app, cùng ô chọn mức suy nghĩ. Các số đo của model này bên dưới chỉ để tham khảo.
- Mic gửi 125 gói mỗi giây (khung 8 ms). Phần mã hoá chỉ tốn khoảng 10 ms CPU cho mỗi phút audio. Gom thành khung lớn hơn sẽ làm trễ thêm, nên không phải hướng tối ưu.

Thử VAD cho V1 (2026-11-20, chỉ trong script, app không đổi). **User declined 2026-11-20:** không thêm công tắc "Trả lời nhanh hơn", VAD giữ mặc định.

gemini-3.8-live, 10 phiên mỗi cấu hình. Mỗi phiên có 2 lượt thường và 2 lượt có quãng ngắt giữa câu (0,5 s và 1 s). "Chen ngang" là khi Iris phát tiếng trước khi câu được gửi hết.

| Cấu hình | V1 p50/p95 (20 lượt) | Chen ngang, ngắt 0,5 s | Chen ngang, ngắt 1 s |
|---|---|---|---|
| Mặc định | 1170 / 1297 ms | 0/10 | 10/10 |
| endOfSpeechSensitivity HIGH | 1158 / 1214 | 0/10 | 10/10 |
| silenceDurationMs 500 | 850 / 1013 | 0/10 | 10/10 |
| silenceDurationMs 300 | 880 / 1650 | 8/10 | 10/10 |
| silenceDurationMs 150 | 830 / 986 | 0/10 (may về thời điểm: server đã nhận ra quãng ngắt, câu trả lời bị huỷ trước khi kịp phát) | 10/10 |

- HIGH giống mặc định, vì đây vốn là mặc định của Gemini Live.
- Ngay cả mặc định cũng chen ngang khi người nói ngắt 1 s.
- Cách chạy lại: `VAD=default|high|sil=<ms> PAUSES=500,1000 node scripts/spikes/live-latency.mjs <out> 10 2 models/gemini-3.8-live`.

V1 theo mức suy nghĩ (2026-11-20, 10 lượt mỗi mức, câu hỏi ngắn), p50/p95 ms:

- extended-thinking (đã gỡ): LOW 1166/1396 · MEDIUM 1181/1389 · HIGH 1171/1582. p50 như nhau, HIGH chỉ có đuôi dài hơn.
- 3.1-flash: none 1307/1434 · MINIMAL 1345/1443 · LOW 1339/1750 · HIGH 1655/2583 (n=9). Mức chỉ làm chậm hơn, không nhanh hơn "không gửi mức", nên flash không có ô chọn mức.
