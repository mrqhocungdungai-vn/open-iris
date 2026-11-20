# Kế hoạch: lõi plugin của open-iris

Ngày 2026-11-20. Trạng thái: chờ user duyệt, chưa sửa code theo bản này.

## 1. Chia việc

- **Livestream không còn nằm trong repo này.** Plugin Livestream (chủ đề, mục tiêu, tóm tắt định kỳ, kêu gọi hành động) do open-iris-plugins-dev làm ở repo `open-iris-plugins`, xem `docs/livestream-plugin-plan.md`.
- **Repo open-iris chỉ làm lõi:** nạp plugin, cài plugin, chạy hook, cổng tin cậy, và tab Plugin. Lõi không có dòng nào riêng cho một plugin cụ thể.
- **Mục tiêu:** khi bên plugins làm xong Livestream 0.2.0, người dùng cài được và chạy thử ngay, không phải sửa thêm gì ở lõi.
- Hợp đồng giữa hai bên là `docs/plugin-hooks-spec.md` (dạng `plugin.json`, `hooks.json`, sự kiện, hook `command`, cổng tin cậy). Đổi hợp đồng thì sửa spec đó trước, rồi báo cho bên kia.

## 2. Quyết định đã chốt

- Bản public bỏ Livestream khỏi lõi. Nút 👂 Chỉ nghe ở lại lõi (`src/main/listen.mjs`). Đã làm (R1).
- Chưa dùng MCP (P3 của `docs/plugin-plan.md`).
- Plugin có hook kiểu Claude Code: `context`, `speak`, và `command` (cần cổng tin cậy). Sự kiện `Tick` thay cho background task.
- Plugin khai tường minh mọi thứ nó đăng ký trong `plugin.json` → `components`. Lõi không tự dò file.
- Lõi tập trung vào bốn phần: voice agent desktop, Hand Task Vision, Gallery View, skill. Plugin chỉ tác động vào các phần đó.

## 3. Lõi cần có để cài và test Livestream

Đây là phần làm trước. Chi tiết nằm ở `docs/plugin-hooks-spec.md`, các bước H1–H5.

| # | Việc (repo open-iris) | Kiểm chứng |
|---|---|---|
| C1 = H1 | `src/main/hooks.mjs` thay `tasks.mjs`: đọc `plugin.json` (`components`, `open_iris_api`, `fields`) và `hooks.json`, kiểm giới hạn, báo lỗi theo từng plugin | `hooks.selftest.mjs`: thiếu khoá, khoá lạ, đường dẫn `..`, `{key}` lạ, `speak` ở SessionStart, API quá mới đều bị từ chối kèm lý do |
| C2 = H2 | `runCommand` (process riêng, env tối thiểu, timeout, đọc tối đa 64 KB) và `trustHash` | Selftest với script thật trong thư mục tạm, như spec mục 9 |
| C3 = H3 | `createHooks().emit` và bộ lập lịch cho `Tick`/`speak` (4 giây im lặng, cách nhau 60 giây, giữ lượt khi 👂) | Selftest với đồng hồ giả |
| C4 = H4 | Gắn vào `main.mjs` bằng khoảng 8 lời gọi `emit`, xoá `tasks.mjs`, `tasks.json`, `SYSTEM_EVENT_TASK` | `grep -rniE "livestream\|recap" src/main` không còn kết quả. Plugin mẫu tối thiểu trong selftest chạy được |
| C5 | **Cài plugin:** nút "Mở thư mục plugin" (đã có IPC `plugins:open`), và ô dán URL GitHub chạy `git clone --depth 1` vào `~/.open-iris/plugins/<tên>/`. Gỡ = xoá thư mục. Mọi thứ cài xong đều tắt | Cài từ URL repo `open-iris-plugins` → thẻ Livestream hiện ra, chưa bật gì |
| C6 = H5 | **Tab Plugin:** mỗi plugin một thẻ gồm tên, phiên bản, công tắc cả gói, ô `fields`, công tắc từng nhóm hook, `every_min` cho `Tick`, hộp thoại tin cậy khi có hook `command`, lỗi hiện ngay trên thẻ. **Xem trước HTML trước** | User duyệt bản xem trước |

**Tiêu chí xong của lõi:** cài Livestream 0.2.0 từ repo `open-iris-plugins`, điền chủ đề và mục tiêu, bật nhóm `brief` và `recap`, bấm Bắt đầu. Iris biết chủ đề ngay lượt đầu, và tự tóm tắt sau khoảng 5 phút. Trong lúc làm, kiểm bằng một plugin giả trong selftest, không chờ bên kia.

**Ranh giới:** lõi không biết "topic", "goal", "recap" là gì. Đó chỉ là `fields` và tên nhóm hook do plugin khai.

## 4. Thành phần plugin làm sau (cũng là lõi)

Làm sau khi C1–C6 xong. Mỗi loại là một khoá trong `components`. Lõi chạy chúng bằng code có sẵn, plugin không mang code.

| Khoá | Plugin thêm gì | Lõi làm gì |
|---|---|---|
| `tools` | Agent tool ghép từ các bước gọi 9 tool desktop có sẵn, ví dụ `notes__new_note` | `desktop.mjs` chạy từng bước qua `call()`, thay `{tham_số}` và `{bước.ref}`. Bước lỗi thì dừng. Luật `RISKY`/`NEEDS_CONFIRMATION` vẫn áp dụng; `confirmed` không đặt sẵn được. Tối đa 20 tool |
| `skills` | Thư mục `skills/<tên>/SKILL.md` | `loadSkills` đọc thêm. Tên hiện là `<plugin>:<skill>`. Trần `SKILLS_MAX` tính chung |
| `gestures` | Cử chỉ tả bằng trạng thái từng ngón (`up`/`down`/`any`), `hold_ms` ≥ 400, hành động là phím hoặc tool của chính plugin | `hand.js` có `matchFingers(lm, fingers)`. Từ chối tư thế trùng cử chỉ lõi và phím return, enter, cmd+q. Chỉ chạy khi Hand Task Vision bật |
| `apps` | Hồ sơ app: `aliases`, `keystroke_typing`, `risky` (chỉ thêm), `brief` (tối đa 300 ký tự) | Gộp vào `desktop.mjs` và `live-config.mjs`, thay một phần `KEYSTROKE_APPS` đang viết cứng |

| # | Việc | Kiểm chứng |
|---|---|---|
| P1 | `tools` + `skills` | Selftest với CLI giả: tool 4 bước chạy đúng thứ tự, dừng ở bước lỗi, nút "Gửi" vẫn trả `NEEDS_CONFIRMATION` |
| P2 | `apps` | Selftest: app có `keystroke_typing` đi đường gõ phím thật; từ rủi ro của plugin chặn click |
| P3 | `gestures` | `hand.test.mjs`: 🤙 khớp, ✊ không khớp; giữ chưa đủ thì không kích, giữ tiếp không kích lần hai |
| P4 | Tab Plugin hiện thêm bốn nhóm này, mỗi mục một công tắc | Plugin mẫu có đủ bốn loại, cài và dùng được |

Gallery View chưa mở cho plugin.

## 5. Rủi ro

- **Hai bên sửa cùng lúc:** hợp đồng đổi mà bên kia không biết. Mọi thay đổi đi qua `docs/plugin-hooks-spec.md` trước.
- **Đụng file với orb:** C4 và C6 sửa `main.mjs`, `preload.cjs`, `index.html`, `renderer.js`, cùng lúc với việc orb của open-iris-dev. Nên commit phần orb trước, hoặc làm tuần tự.
- **Hook `command` là code lạ chạy với quyền của user,** không có sandbox. Cổng tin cậy theo mã băm, env tối thiểu, timeout. Hộp thoại phải nói rõ.
- **Gemini đóng phiên sau khoảng 10 phút** (L0, chưa giao ai). Trước khi có L0, livestream dài phải bấm Bắt đầu lại, và `Tick` đếm lại từ đầu.
- **Tool ghép giòn, cử chỉ bắn nhầm, `brief`/skill là prompt:** giữ các biện pháp ở mục 4 (mặc định tắt, giới hạn độ dài, cổng xác nhận của lõi).

## 6. Câu hỏi cần chốt

1. Ba câu ở `docs/plugin-hooks-spec.md` mục 11: cách đánh phiên bản, phạm vi mã băm tin cậy, hook `command` ở `UserTurn`/`IrisTurn`.
2. ~~Session nào code lõi?~~ Đã chốt một phần (2026-11-20): open-iris-plugins-dev làm C1–C3, chỉ trong `hooks.mjs`, selftest của nó và script test. C4–C6 giao cho open-iris-dev, làm sau khi xong orb.
3. ~~Tool ghép (`tools`) có cần chạy shell hay AppleScript không?~~ Đã chốt (2026-11-20, user): **có thêm tool loại `command`** bên cạnh tool ghép, cho plugin `orca` (`open-iris-plugins/docs/orca-plugin-plan.md` K1–K4). Dùng chung cổng tin cậy theo mã băm với hook `command`, mọi tool plugin mặc định tắt, iris-security quét trước khi merge.
4. Đã chốt (2026-11-20, user), sau K1–K4:
   - **Cờ tainted: có.** Sau khi output plugin tới Gemini, các tool desktop hành động (click, gõ, phím, chọn mục, mở app) trả `NEEDS_CONFIRMATION`, tới khi có lời nói hoặc chữ gõ thật của user. Làm bằng hook `PreToolCall` của lõi.
   - **Kết quả `late`: giữ `WHEN_IDLE`** (Iris tự nói khoảng 50–67%), không dùng `INTERRUPT`.
   - **Kết quả `late` không mất khi nối lại hay ↺:** gửi vào phiên mới thành một lượt text của client.
   - **Cho chạy O3**, test thật với session Orca.
5. Đã chốt (2026-11-20, user), sau lần quét bảo mật của tool plugin: sửa cả 5 lỗi (2 trung bình, 3 thấp, `ops-logs/security/2026-11-20/REPORT.md`). Khi cờ tainted bật, **giữ mọi tool của plugin**, không chỉ tool có `confirm`. Hộp thoại tin cậy hiện tên từng tool.

## Liên quan

- `docs/plugin-hooks-spec.md`: hợp đồng hook, nguồn chi tiết cho C1–C6.
- `docs/livestream-plugin-plan.md`: plugin Livestream, việc của repo `open-iris-plugins`.
- `docs/plugin-plan.md`: P1 (skill) đã xong. P2 (hooks) giờ là spec hook. P3 (MCP) để sau.
- Code Livestream cũ còn trong lịch sử git, từ commit `1c97738` trở về trước.
