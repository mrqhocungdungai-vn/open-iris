# Kế hoạch: thông báo hệ thống bằng giọng nói

Ngày 2026-11-21. Trạng thái: A0–A4 xong (1c172ae, bc40e4e, 78737b9, 9df930c); sửa thêm: mở app và tải lại trang không đọc (7f25689, efbee5b). User thử thật camera và giọng: ổn (2026-11-21).

Yêu cầu: khi bật/tắt Hand Task Vision, điều khiển bằng tay hay listen mode, app đọc một câu thông báo hệ thống ngắn. Câu này không chèn vào hội thoại với Iris.

## 1. Hiện trạng

- 🤘 / ⌃⌥G đổi điều khiển bằng tay: `hud.mjs` `setControl` gọi callback `onControl`. `main.mjs:742` gửi lượt `[hand control] ... Tell the user` vào phiên Live, và Iris nói. Chưa Start thì không có thông báo nào.
- Bật/tắt Hand Task Vision (`hud.mjs` `setVision`): không có thông báo.
- 👍 / 👂 listen mode: `setListenOnly` gửi `LISTEN_ON_EVENT` / `LISTEN_OFF_EVENT` thành một lượt đầy đủ để Iris nói. Phải mở khe `announcing` 8 s cho câu đó lọt qua cổng im lặng (có `// shortcut:`). Chỉ chạy khi Iris đang chạy.
- Hệ quả: câu thông báo nằm trong lịch sử hội thoại, tốn context, chậm theo model, và phụ thuộc phiên.

## 2. Quyết định của user (2026-11-21)

- Câu ngắn, cố định, tiếng Anh:
  - `Hand Task Vision enabled` / `Hand Task Vision disabled`
  - `Hand control on` / `Hand control off`
  - `Listen mode active` / `Listen mode inactive`
- Đọc ngoài hội thoại, được đè lên tiếng Iris.
- Dùng cùng API key, model Live và giọng như Iris, qua một phiên riêng, không dùng phiên đang chạy.
- Hand Task Vision và điều khiển bằng tay là con chuột: dùng được và có thông báo cả khi chưa Start.
- Listen mode giữ như cũ: tắt khi mở app, chỉ bật/tắt được khi Iris đang chạy. Chưa Start thì 👍 chỉ hiện "Iris chưa chạy" trên HUD, không đọc gì.
- Khi Iris đang chạy, Iris chỉ nhận ghi chú im lặng và không tự nói thông báo.

## 3. Thiết kế

### 3.1 Tạo và lưu file âm thanh

- Mỗi câu chỉ tạo một lần. App mở một phiên Live riêng (cùng model, cùng `voiceName`), gửi "Say exactly: <câu>", lấy audio PCM 24 kHz, rồi đóng phiên.
- So phần `outputTranscription` với câu mẫu (bỏ hoa thường và dấu câu). Lệch thì tạo lại, tối đa 2 lần. Vẫn lệch thì giữ lần cuối (vẫn đúng giọng) và ghi log `[announce] mismatch`.
- Lưu ở `~/.open-iris/announce/<model>/<voice>/<key>.pcm`. Đổi model hoặc giọng thì tạo lại ở nền.
- Không có giọng local. Tạo đủ 6 file ở nền ngay khi mở app (có key) và khi đổi model hoặc giọng. Lúc file chưa có (máy mới, mất mạng, chưa có key) thì im lặng, chỉ HUD hiện như cũ, ghi log `[announce] missing <key>`; lần sau có mạng thì tạo tiếp.

### 3.2 Phát

- Phát trong cửa sổ chính (renderer), bằng một nguồn riêng, không đi qua hàng đợi tiếng Iris. Vì vậy phát chồng lên Iris được, và câu "Iris nói xong" không bị ảnh hưởng.
- Phát cùng trang với mic thì chống vọng tiếng của Chrome trừ được âm này. Phải đo ở A0.
- Nếu A0 đo thấy Gemini vẫn nghe được câu thông báo thì tạm ngừng gửi mic trong lúc phát (dưới 2 s).

### 3.3 Ghi chú im lặng cho Gemini

- Thay lượt "Tell the user" bằng `sendClientContent` với `turnComplete: false`, như ghi chú khi nối lại. Ví dụ `[hand control] Hand control is now ON.`
- Đổi `LISTEN_ON_EVENT` / `LISTEN_OFF_EVENT` thành câu trạng thái, không bảo Iris nói. Bỏ `announcing` và khe 8 s. Cắt tiếng Iris khi bật listen mode thì giữ nguyên.
- Công tắc System Announcements tắt: vẫn gửi ghi chú im lặng, chỉ không đọc gì. Không quay lại cách để Iris nói.

### 3.4 Giao diện giữa hai owner

- `initGesture(log, home, onChange)`: `onChange(event, on)` với `event` là `"vision"` hoặc `"control"`. Chỉ gọi khi trạng thái thật sự đổi (giữ logic "say it only on a real change" hiện có).
- Lưu ý `setVision` gọi `setControl(false)`. Tắt Vision khi đang điều khiển sẽ ra 2 câu: "Hand Task Vision disabled" rồi "Hand control off". Bỏ câu "Hand control off" nếu nó đi kèm việc tắt Vision.
- Main: `announce(key)`, với `key` thuộc `vision-on|vision-off|control-on|control-off|listen-on|listen-off`. Main gửi IPC `announce:play` kèm đường dẫn file cho renderer; chưa có file thì bỏ qua.

### 3.5 Công tắc

- Tab Tính năng, mục **System Announcements** ngay dưới Hand Task Vision, mặc định bật, lưu trong config như các công tắc khác. Bản xem trước `announce-preview.html` đã duyệt 2026-11-21. Dòng mô tả phải nói rõ câu listen mode chỉ đọc khi Iris đang chạy.

## 4. Các bước

| Bước | Owner | Việc | Kiểm tra |
|---|---|---|---|
| A0 | iris-core | Spike trong script, app không đổi: phiên Live riêng đọc 6 câu với 2 model; đo thời gian tạo, đếm số lần lệch chữ; phát trong renderer khi mic mở, xem Gemini có nghe thấy không | số đo ghi vào `optimize-plan.md` §4 |
| A1 | iris-vision | `hud.mjs`: `onChange("vision"/"control", on)`, bỏ câu control kép khi tắt Vision | test trong `*.test.mjs` của gesture |
| A2 | iris-core | `src/main/announce.mjs`: câu mẫu, đường dẫn file, so chữ, tạo file ở nền khi mở app và khi đổi model/giọng; IPC `announce:play`, phát trong renderer | `announce.test.mjs`: khóa đường dẫn, so chữ, thiếu file thì bỏ qua không lỗi |
| A3 | iris-core | Ghi chú im lặng thay cho các lượt "Tell the user"; bỏ `announcing` | `listen` test: không còn turnComplete true, không còn khe 8 s |
| A4 | iris-core | Công tắc Settings theo bản xem trước đã duyệt | thử tay trong `pnpm dev` |
| A5 | iris-po | Review, `pnpm test`, gitleaks, iris-security xem IPC mới, thử thật cả 6 câu trước và sau Start | log `[announce]` trong `main.log` |

Thứ tự: A0 trước. A1 và A2 làm song song. A3 và A4 sau A2.

## 5. Rủi ro

- Model Live hay diễn đạt lại câu: đã có bước so chữ và tạo lại.
- Mic thu lại câu thông báo: đo ở A0.
- Lần đầu mở app khi mất mạng thì chưa có thông báo nào cho tới khi tạo được file.
- Tạo file lần đầu tốn quota. Chỉ 6 câu cho mỗi model và giọng, chạy ở nền, không chặn cử chỉ.
- Gemini không nghe câu thông báo, nên khi user hỏi "vừa bật gì vậy" thì Iris chỉ biết qua ghi chú im lặng. Chấp nhận được.

## 6. Ngoài phạm vi

- Thông báo cho sự kiện khác (Gallery, mute, plugin): chưa làm. Nếu cần, plugin dùng hook riêng sau.
- Câu tiếng Việt: chưa làm, theo quyết định câu tiếng Anh.
- Listen mode khi chưa Start: user giữ như cũ (B).
