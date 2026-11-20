# Context meter: hiển thị độ đầy cửa sổ context

Ngày 2026-11-20. Người làm: open-iris-dev2. Tài liệu liên quan: `docs/session-plan.md`, phần "Giữ phiên dài" (S1–S3, commit `c99e061`).

## 1. Mục tiêu

Trong lúc phiên đang chạy, người dùng nhìn thấy context của Gemini đang đầy đến đâu, và còn bao xa nữa thì server bắt đầu cắt bớt lịch sử.

Phạm vi:

- Chỉ hiển thị, không thay đổi cách phiên chạy.
- Không cảnh báo bằng giọng nói.
- Không lưu lịch sử token.

## 2. Gemini Live cho gì

Nguồn: [Live API reference](https://ai.google.dev/api/live) và [capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

- **`usageMetadata`:** server gửi định kỳ, có thể đi kèm một trường khác của tin nhắn. Gồm:
  - `promptTokenCount`: đầu vào của lượt, đã gồm cả lịch sử;
  - `responseTokenCount`;
  - `totalTokenCount`;
  - số token chia theo modality.
- **Kích thước cửa sổ:** API không trả về, nên phải ghi cứng theo từng model.
- **Điểm cắt mặc định của `slidingWindow: {}`:** khoảng 80% cửa sổ, cắt xuống còn khoảng một nửa (§2 session-plan).
- **Sai số:** trên diễn đàn có báo cáo `promptTokenCount` của gemini-3.8-live lệch khoảng 25 token so với tổng theo modality. Mức đó đủ chính xác để hiển thị.
- `main.mjs` hiện chưa đọc `usageMetadata`.

## 3. Cần xác minh bằng spike (C0)

Chạy với API thật, trên cả 3 model trong `MODELS`:

1. Trường nào phản ánh kích thước context hiện tại: `promptTokenCount` của lượt gần nhất, hay `totalTokenCount`?
2. `usageMetadata` đến lúc nào: sau mỗi `turnComplete`, hay cả giữa lượt?
3. Sau khi `slidingWindow` cắt, con số có giảm không? Ép bằng cách đặt `triggerTokens` thấp trong spike.
4. Sau khi resume, con số đếm tiếp từ lịch sử cũ hay bắt đầu lại từ 0?
5. Kích thước cửa sổ của từng model, theo trang model của Google. Ghi lại nguồn.

Ghi kết quả vào §6 của file này.

## 4. Thiết kế

- **Logic:** file mới `src/main/context-meter.mjs` có hàm thuần `contextMeter(usage, model)`, trả về `{ used, max, trimAt }` hoặc `null` nếu thiếu dữ liệu.
  - Bảng kích thước cửa sổ theo model nằm trong file này.
  - Test: `context-meter.test.mjs`, thêm vào script `test`.
- **Main:** trong `handleMessage`, khi tin nhắn có `usageMetadata` thì gọi `contextMeter` và gửi kết quả sang renderer qua IPC. Gửi lại sau mỗi lần nối lại phiên.
  - Nếu kết quả C0 cho thấy con số bắt đầu lại từ 0 sau resume, xử lý theo kết quả đó và ghi chú `shortcut:` nếu cần.
- **Preload:** thêm một callback, ví dụ `onContext`.
- **Renderer:** một chỉ báo nhỏ cạnh `#status`, ví dụ `ctx 52k / 128k`, kèm thanh mảnh có vạch ở `trimAt`.
  - Tooltip giải thích rằng tới vạch thì Iris quên bớt phần đầu cuộc trò chuyện.
  - Ẩn khi phiên không chạy.
- **Công tắc riêng:** "Hiện mức context" trong tab Tính năng, đặt sau "Giữ phiên dài", mặc định bật. Lưu ở `config.session.meter`; nếu config thiếu khoá này thì coi là bật.
  - Công tắc không phụ thuộc "Giữ phiên dài". Khi "Giữ phiên dài" tắt, phiên không có cơ chế cắt, nên chỉ hiện con số và không vẽ vạch.
- **HUD:** chưa làm, chờ user yêu cầu.

## 5. Các bước

| Bước | Việc | Kiểm tra |
|---|---|---|
| C0 | Spike xác minh 5 điểm ở §3 | Kết quả ghi trong §6 |
| C1 | `context-meter.mjs` và test | `pnpm test` qua |
| C2 | Bản xem trước HTML cho chỉ báo và công tắc, dùng `style.css` thật | PO và user duyệt |
| C3 | Nối vào main, preload và renderer, thêm công tắc | `pnpm test` qua. Trong `pnpm dev`, con số tăng dần qua các lượt và vẫn còn sau khi nối lại |

Không commit nếu chưa có lệnh. Không gửi màn hình terminal cho Gemini.

## 6. Kết quả C0

Chạy ngày 2026-11-20 bằng `scripts/spikes/live-usage.mjs` (không commit). Cấu hình spike: `triggerTokens: "3000"`, `targetTokens: "1000"`, 6 lượt text, mỗi lượt khoảng 800 token, sau đó đóng và resume bằng handle.

| Điểm §3 | Kết quả |
|---|---|
| 1. Trường nào | `promptTokenCount` của tin gần nhất. `totalTokenCount` = prompt + response, nên không dùng làm kích thước context |
| 2. Lúc nào | Cả 3 model: đúng 1 `usageMetadata` mỗi lượt, nằm cùng tin có `turnComplete` (6/6). Giữa lượt không có. Chưa thử lượt bằng giọng nói |
| 3. Sau khi cắt | Con số giảm. 3.1-flash: 949 → 1806 → 2640 → **1004** → 1861 → 2696. 3.8-live: 1352 → 2189 → **1352** → 2186 → 3026 → **1352** (cắt sớm hơn trigger, xuống gần target) |
| 4. Sau resume | Con số đếm tiếp từ lịch sử (đã cắt), không về 0. 3.8-live: 1352 → 1389; 3.1-flash: 2696 → 1865 (resume có thể kích hoạt một lần cắt) |
| 5. Cửa sổ | **131.072** token đầu vào cho cả 3 model (output 65.536), theo trang model trên aistudio.google.com/docs (ai.google.dev chuyển hướng sang đó). §2 và §4 ghi "128k" là cách làm tròn; chỉ báo hiển thị `131k` |

Ghi chú:

- Mặc định của `slidingWindow: {}`: `triggerTokens` = 80% cửa sổ ≈ 104.858, `targetTokens` = trigger/2 ≈ 52.429. Đây là `trimAt` trong `contextMeter`.
- `promptTokensDetails` chỉ có `TEXT` và `AUDIO`. `thoughtsTokenCount` có ở 3.8-live, không có ở 3.1-flash.
- **gemini-3.8-live-extended-thinking:** nếu không có `thinkingConfig.thinkingLevel`, server đóng ngay với `1007 "Thinking level must be specified for this model."`, nên lần chạy đầu không có dữ liệu. `liveSetup` hiện không gửi `thinkingConfig`, nên chọn model này trong app có thể hỏng sẵn (chưa thử trong app, báo PO riêng). Với `thinkingLevel: "LOW"`, `usageMetadata` có như 2 model kia (6/6 trên `turnComplete`), nhưng `promptTokenCount` đứng yên ở 3746 suốt 6 lượt, rồi 2952 sau resume. Có thể model này báo con số theo cách khác hoặc cắt mỗi lượt. Chấp nhận được cho chỉ báo, không cần xử lý riêng.
