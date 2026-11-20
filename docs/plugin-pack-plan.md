# Kế hoạch: plugin dạng gói dữ liệu (không MCP) và bỏ Livestream khỏi bản public

Ngày 2026-11-20. Trạng thái: nghiên cứu, chờ chốt câu hỏi ở mục 7. Chưa sửa code.

## 1. Quyết định đã chốt (2026-11-20)

- Bản public **bỏ Livestream**: đồng dẫn, chủ đề, tóm tắt 5 phút. **Giữ nút 👂 Chỉ nghe** như tính năng lõi, chuyển sang `src/main/listen.mjs`. Lõi không cần một tính năng cá nhân hoá mạnh như vậy. Code vẫn còn trong lịch sử git (commit `1c97738` trở về trước).
- **Chưa dùng MCP**, không có process plugin, không có background task. Làm sau (P3 của `docs/plugin-plan.md`).
- Lõi tập trung vào bốn phần: **voice agent desktop**, **Hand Task Vision**, **Gallery View**, **skill**.
- Plugin chỉ tác động vào bốn phần đó. Cài một plugin thì thấy ngay nó thêm những gì: agent tool nào, skill nào, cử chỉ tay nào, hiểu biết về app nào.

## 2. Ý chính: plugin là gói dữ liệu, không chứa code

Plugin v1 chỉ có file JSON và Markdown. Iris đọc rồi tự làm, bằng code có sẵn của lõi. Nhờ vậy:
- Không chạy code lạ: không cần sandbox, không cần process riêng, không cần MCP.
- Mọi thao tác vẫn đi qua cổng an toàn hiện có: hàng đợi desktop, `RISKY` + `NEEDS_CONFIRMATION`, xác nhận phím return, khoá tay khi Gemini đang điều khiển (`lockHand`).
- Cài plugin = chép một thư mục. Gỡ = xoá thư mục.

```
my-plugin/
  .open-iris-plugin/plugin.json   # tên, phiên bản, mô tả
  tools.json        # agent tool: chuỗi bước agent-desktop          (tuỳ chọn)
  skills/<tên>/SKILL.md           # skill, giống ~/.open-iris/skills (tuỳ chọn)
  gestures.json     # cử chỉ tay → hành động                         (tuỳ chọn)
  apps.json         # hồ sơ app cho voice agent desktop              (tuỳ chọn)
```

Nằm ở `~/.open-iris/plugins/<tên>/`. Bố cục giữ giống `docs/plugin-plan.md` 4.1 (`.open-iris-plugin/plugin.json`, `skills/`), nên sau này thêm `hooks/` hay `.mcp.json` vào cùng thư mục được.

## 3. Bốn thứ một plugin thêm được

### 3.1 Agent tool (`tools.json`): tool ghép từ các bước agent-desktop

Một tool là chuỗi bước gọi lại 9 tool desktop có sẵn. Gemini thấy nó như một tool bình thường.

```json
[{
  "name": "new_note",
  "description": "Create a new note in Apple Notes with the given text.",
  "parameters": { "text": "Text of the note" },
  "steps": [
    { "tool": "open_or_focus_app", "args": { "app": "Notes" } },
    { "tool": "press_key_combo", "args": { "app": "Notes", "combo": "cmd+n" } },
    { "tool": "find_app_control", "args": { "app": "Notes", "role": "textarea" }, "as": "body" },
    { "tool": "type_into_text_field", "args": { "app": "Notes", "ref": "{body.ref}", "text": "{text}" } }
  ]
}]
```

- `{text}` lấy từ tham số Gemini truyền. `{body.ref}` lấy ref đầu tiên mà bước có `"as": "body"` tìm được. Chỉ thay chuỗi, không có biểu thức.
- Bước nào lỗi thì dừng, trả lỗi của bước đó cho Gemini.
- Mỗi bước chạy qua đúng hàm `call()` của `desktop.mjs`, nên luật an toàn vẫn áp dụng: click nút "Gửi" vẫn cần `confirmed`, return vẫn cần xác nhận. `confirmed` không đặt sẵn được trong `tools.json`; tool ghép có tham số `confirmed` thì nó chỉ được truyền tiếp xuống từ Gemini.
- Tên gửi Gemini là `<plugin>__<tool>`, ví dụ `notes__new_note`. Mỗi tool có công tắc riêng, cài xong mặc định **tắt**.
- Gemini chốt danh sách tool lúc kết nối, nên bật/tắt có hiệu lực từ lần Start kế tiếp.
- `// shortcut: tối đa 20 tool từ plugin, nâng khi eval đo được ngân sách tool`.

### 3.2 Skill (`skills/`)

- Giống hệt skill ở `~/.open-iris/skills/` (đã có). `loadSkills` đọc thêm thư mục `skills/` của mỗi plugin đang bật.
- Tên skill hiện cho người dùng là `<plugin>:<skill>`, để không đụng skill cá nhân.
- Trần 20 skill hiện có (`SKILLS_MAX`) tính chung cho cả skill cá nhân và skill plugin.

### 3.3 Cử chỉ Hand Task Vision (`gestures.json`)

Plugin **mô tả** tư thế bằng trạng thái từng ngón, engine của Iris nhận diện. Plugin không viết code nhận diện.

```json
[{
  "name": "shaka_play",
  "label": "🤙 ngón cái + út → phát / dừng",
  "label_en": "🤙 thumb + little finger → play / pause",
  "fingers": { "thumb": "up", "index": "down", "middle": "down", "ring": "down", "pinky": "up" },
  "hold_ms": 600,
  "action": { "key": "space" }
}]
```

- `fingers`: mỗi ngón `up`, `down` hoặc `any`. Engine dùng hàm `extended()` sẵn có trong `hand.js`.
- `hold_ms` ít nhất 400. Mỗi lần giữ tư thế chỉ kích một lần, đổi tư thế mới kích lại (giống 🤘).
- `action` là một trong hai:
  - `{ "key": "<tổ hợp phím>" }` gửi cho app đang ở trước. Return, enter và cmd+q bị từ chối.
  - `{ "tool": "<tool trong tools.json của chính plugin>", "args": {...} }`.
- Luật lõi:
  - Tư thế trùng cử chỉ lõi (✋ mở, ✊ nắm, ✌ V cuộn, 🤘 khoá, 👍 chỉ nghe, chụm ngón) bị từ chối lúc đọc plugin, và lý do ghi vào log.
  - Chỉ chạy khi Hand Task Vision bật và đang ở chế độ điều khiển (chưa khoá bằng 🤘). Không phụ thuộc nút Start voice.
  - Mỗi cử chỉ có công tắc riêng, mặc định tắt.
- HUD và hướng dẫn hiện `label` của cử chỉ đang bật.

### 3.4 Voice agent desktop (`apps.json`): hiểu biết về app

Đây là những thứ hiện đang viết cứng trong `desktop.mjs`, và mỗi app cần một ít:

```json
[{
  "app": "Microsoft Teams",
  "aliases": ["teams", "tim"],
  "keystroke_typing": true,
  "risky": ["chia sẻ màn hình", "share screen"],
  "brief": "In Teams, the message box is a textarea named 'Type a message'."
}]
```

| Trường | Thay cho | Tác dụng |
|---|---|---|
| `aliases` | không có | Tên gọi khi nói ("tim", "ghi chú") → tên app thật, đưa vào system instruction |
| `keystroke_typing` | `KEYSTROKE_APPS` (đang là `shortcut:` theo tên app) | App cần gõ phím thật vì gõ ngữ nghĩa không ăn |
| `risky` | `RISKY` | Thêm từ khoá nút cần xác nhận cho app đó. Chỉ **thêm** được, không bớt từ của lõi |
| `brief` | không có | Một câu ngắn về app, nối vào system instruction khi tool desktop bật. Tối đa 300 ký tự |

Hướng dẫn dài cho từng app thì viết thành skill (3.2), vì skill chỉ nạp khi cần.

### 3.5 Gallery View

Theo bốn mục bạn nêu, v1 chưa cho plugin đụng vào Gallery View. Nếu cần sau này, ví dụ thêm thư mục mở nhanh hoặc loại file xem được, thì cũng làm theo kiểu dữ liệu như trên.

## 4. Tab Plugin

Xem trước HTML tạm trước khi sửa UI (luật repo).

- Tab thứ tư "Plugin".
- Mỗi plugin là một thẻ: tên, phiên bản, link nguồn, công tắc cả gói, rồi bốn nhóm, mỗi mục một công tắc:
  - **Agent tools**: `notes__new_note`, kèm các bước tool đó chạy (`mở Notes → cmd+n → gõ`), để người dùng biết nó làm gì.
  - **Skills**.
  - **Cử chỉ tay**: nhãn, ví dụ "🤙 → phát / dừng".
  - **App**: tên app, kèm `keystroke_typing` và từ khoá rủi ro nếu có.
- Thêm plugin: nút "Mở thư mục plugin" (giống nút mở thư mục skill hiện có) và ô dán URL GitHub. Ô URL chạy `git clone --depth 1`; plugin không có code nên không cần hộp thoại tin cậy. Mọi thứ cài xong đều tắt.
- Plugin hỏng (JSON sai, tư thế trùng, bước gọi tool không có thật) hiện lỗi ngay trên thẻ, không làm hỏng app.

## 5. Các bước

Mỗi bước kết thúc bằng `pnpm test` qua.

| # | Việc | Kiểm chứng |
|---|---|---|
| R1 ✅ | **Bỏ Livestream:** xoá `livestream.mjs` và selftest của nó; chế độ chỉ nghe (`LISTEN_*_EVENT`, `refuseCalls`) chuyển sang `listen.mjs` + `listen.selftest.mjs`; trong `main.mjs` bỏ `cohost/recap/topic`, `createRecap`, IPC `config:live`; `preload.cjs` bỏ `saveLive`; bỏ khối Livestream ở tab Tính năng (giữ nút 👂); sửa README, `public-refactor-plan.md`. | `grep -rniE "livestream\|cohost\|recap\|topic" src` không còn kết quả. `pnpm dev`: Start, nói "mở Safari" vẫn chạy. |
| P1 | `src/main/plugins.mjs`: đọc và kiểm `plugin.json`, `tools.json`, `apps.json`, `gestures.json`; báo lỗi theo từng plugin; lưu công tắc vào `config.json` → `plugins`. Chỉ logic, không có Electron. | `plugins.selftest.mjs`: JSON sai, tên trùng, bước gọi tool lạ, tư thế trùng lõi, `confirmed` đặt sẵn đều bị từ chối kèm lý do. |
| P2 | Agent tool ghép và skill plugin: `desktop.mjs` chạy các bước, thay `{...}`; `loadSkills` đọc thêm thư mục plugin. | Selftest với CLI giả: tool 4 bước chạy đúng thứ tự, dừng ở bước lỗi, nút "Gửi" vẫn trả `NEEDS_CONFIRMATION`. Eval: thêm câu "tạo ghi chú mua sữa" → `notes__new_note`. |
| P3 | Hồ sơ app: `aliases`, `keystroke_typing`, `risky`, `brief` gộp vào `desktop.mjs` và `live-config.mjs`. | Selftest: app có `keystroke_typing` đi đường gõ phím thật; từ rủi ro của plugin chặn click. |
| P4 | Cử chỉ plugin: main gửi danh sách cử chỉ đang bật qua preload; `hand.js` có hàm thuần `matchFingers(lm, fingers)`; engine kích action sau `hold_ms`. | `hand.test.mjs`: 🤙 khớp, ✊ không khớp; giữ chưa đủ thì không kích, giữ tiếp không kích lần hai. |
| P5 | Tab Plugin theo bản xem trước đã duyệt. Repo mẫu `open-iris-plugin-example` có đủ bốn loại. | Cài repo mẫu từ URL, bật từng mục, dùng được cả bốn. |

R1 làm độc lập với P1–P5, có thể làm trước và commit riêng.

## 6. Rủi ro

- **Tool ghép giòn:** giao diện app đổi thì bước `find_app_control` hỏng. Lỗi trả về cho Gemini kèm tên bước, Gemini có thể tự làm tay bằng tool desktop thường.
- **Cử chỉ bắn nhầm:** tư thế lỏng (nhiều `any`) dễ khớp khi tay đang chuyển tư thế. Đã có: `hold_ms` tối thiểu, `settle()` qua nhiều khung, và mặc định tắt. Nên thêm luật: ít nhất 4 ngón không phải `any`.
- **`brief` và skill là prompt:** plugin có thể viết câu dụ Gemini làm bậy. Giới hạn độ dài, và cổng xác nhận của lõi vẫn chặn thao tác rủi ro.

## 7. Câu hỏi cần bạn chốt

1. ~~**"Thêm voice agent desktop nào"**~~ Đã chốt (2026-11-20): là hồ sơ app (3.4).
2. **Tool ghép (3.1)** chỉ gọi 9 tool desktop có sẵn. Có cần cho plugin chạy lệnh shell hay AppleScript không? Mình đề xuất **chưa**, vì đó là chạy code lạ, nên để sau cùng với MCP.
3. ~~**Nút 👂 Chỉ nghe**~~ Đã chốt (2026-11-20): giữ ở lõi.
4. ~~**R1 (bỏ Livestream)**~~ Đã làm (2026-11-20).

## Liên quan

- `docs/plugin-plan.md`: P1 (skill) đã xong. P2 (hooks) và P3 (MCP) để sau. Mục 4.5 nhắc `builtin/coding` đã lỗi thời từ commit `1c97738`.
- `docs/public-refactor-plan.md`: đã sửa dòng livestream ở mục Mục tiêu (R1).
