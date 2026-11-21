# Bổ sung tool desktop: overlay, cuộn, nhiều cửa sổ, đóng app

Ngày 2026-11-21. Người làm: iris-desktop. Điều phối: iris-po.

Hiện có 9 tool desktop. Gemini Live mở app, quét, đọc, bấm, gõ và nhấn phím được, nhưng còn bốn chỗ hổng khiến nó không tự làm trọn việc mà phải nhờ tay hoặc đoán mò:

1. Không thấy menu, sheet, alert, popover. Các thứ này nằm ngoài cây cửa sổ mà tool đang quét.
2. Không cuộn được nội dung dài.
3. App có nhiều cửa sổ thì bị `AMBIGUOUS_TARGET` và không có cách chọn cửa sổ.
4. Đóng app phải đi tìm nút đóng, vì `cmd+q` bị `POLICY_DENIED`.

Nguồn: agent-desktop 1.3.1, bản mới nhất ngày 2026-11-13. Đã đọc skill tích hợp và `--help` của từng lệnh, và chạy thử trên máy này ngày 2026-11-21.

## Quy tắc chung

- **Đo trước, sửa sau.** Bước 0 của mỗi mục ghi số trước và sau vào `docs/optimize-plan.md` §4: token theo T1 (nền hiện tại là 1539 cho 9 tool cộng `DESKTOP_BRIEF`) và V2 của tool mới.
- Mỗi tool mới có công tắc riêng trong `TOOL_DEFAULTS`. `main.mjs` và `list_my_abilities` tự lấy theo, không cần sửa.
- Mỗi thay đổi logic có selftest với CLI giả trong `desktop.selftest.mjs`. Đổi chữ mô tả thì chạy `node eval/tool-choice.mjs --runs 3`: case cũ không được tụt, case mới phải đạt.
- Bấm gửi, xoá, thanh toán vẫn phải hỏi trước, và tool là nơi chặn. Không mở rộng sang headed khi không cần.
- Tool chỉ đọc trong app được nêu tên. Không bao giờ đọc terminal.
- Mỗi mục đi theo vòng `ops-logs/history.jsonl`: proposed, rồi approved (chỉ người dùng duyệt), rồi done kèm commit.
- Thứ tự làm: 4 (nhỏ, rủi ro thấp), 2, 1, 3.

## 1. `surface` cho find, scan, read

**Vấn đề.** Menu đã mở, hộp thoại Save, alert "Don't Save" và popover không nằm trong cây cửa sổ. Gemini quét và không thấy gì, nên đoán hoặc bỏ cuộc. Agent-desktop có `--surface menu|menubar|sheet|popover|alert|focused` cho `snapshot` và `find`. Mỗi action cũng trả về `data.surfaces`, liệt kê overlay vừa mở.

**Bước 0.**
- Chạy thử trên TextEdit (sheet Save, alert đóng file chưa lưu), Finder (menu chuột phải), Safari (popover) và một app Electron (VS Code). Ghi lại surface nào thấy được, surface nào đã có sẵn trong cây cửa sổ. Menu chắc chắn nằm ngoài; sheet và alert chưa kiểm.
- Nếu sheet và alert đã nằm trong cây cửa sổ thì chỉ cần thêm `menu` và `menubar`, và enum nhỏ lại.

**Thay đổi.**
- Thêm tham số `surface` (enum `menu`, `menubar`, `sheet`, `alert`, `popover`) cho `find_app_control`, `scan_app_controls` và `read_app_text`.
- Có `surface` thì bỏ `--root` và `--skeleton`, vì agent-desktop không cho dùng `--surface` cùng `--root`. Tool trả lỗi rõ nếu Gemini truyền cả hai.
- `click_app_control` và `pick_list_option` trả về `surfaces` khi `data.surfaces` không rỗng, để Gemini biết vừa mở overlay nào.
- Thêm một dòng brief: "Bấm xong mà có `surfaces` thì find hoặc scan với `surface` đó."
- Ref từ một surface vẫn là `@snap:eN` bình thường, nên click, type và risky check không đổi. Phải kiểm lại `RISKY`: nút "Delete" hay "Don't Save" trong alert vẫn phải hỏi trước.

**Test.**
- Argv đúng cho từng tool khi có `surface`.
- Có cả `surface` và `root` thì báo lỗi.
- `surfaces` được trả về sau một click.
- Bấm "Delete" trong alert vẫn ra `NEEDS_CONFIRMATION`.

**Eval mới.**
- "Mở menu File của TextEdit" → `click_app_control` hoặc `find_app_control` với `surface: menubar`.
- "Bấm Don't Save" khi đang có alert → `find_app_control` với `surface: alert`.

**Token ước tính:** +60 đến +120.

**Trạng thái 2026-11-21:** đã code, chưa commit. Bước 0 (chỉ TextEdit) đổi enum thành `menubar`, `sheet`, `focused`: `--surface alert` không thấy alert thoát app, chỉ `focused` thấy; menu không mở được headless (menubar snapshot đã chứa cả cây); popover chưa thử. Surface lạ (kể cả surface hệ thống) bị `INVALID_ARGS` trước khi gọi CLI. `find --surface menubar` luôn `TIMEOUT` trên TextEdit, nên `find_app_control` với menubar lấy snapshot rồi lọc theo role/tên trong tool (tối đa 50 kết quả). Mọi kết quả có `data.surfaces` không rỗng thì có thêm `surfaces` ở ngoài cùng. `RISKY` thêm `discard`, `quit`, `don't save`, `không lưu`: alert có "Save and Quit"/"Don't Save" giờ cũng hỏi trước. `get` text trả nhãn AX của nút chỉ có icon, nên không cần thêm property. Schema +552 ký tự cộng một câu brief (~150 token, vượt ước tính; chưa đo theo T1). Eval `--runs 3`: hai case surface 3/3 (có kiểm `surface`), tổng 58/60; hai case cũ 2/3 chạy lại `--runs 5` đều 5/5. Chưa thử Finder, Safari, VS Code (#674).

## 2. `scroll_app_view`

**Vấn đề.** Không cuộn được danh sách dài, trang web hay chat. `read_app_text` chỉ đọc phần đã có trong cây. Nhiều app (Electron, list ảo hoá) chỉ dựng phần đang hiện trên màn hình. Tay có cử chỉ cuộn, nhưng mục tiêu là nói "cuộn xuống" cũng chạy.

**Bước 0.** Đo `scroll @ref --direction down --amount 3` headless trên Safari, Finder (list) và VS Code. Ghi V2 và xem `post_action_verification` có báo sai như click không.

**Thay đổi.**
- Tool mới `scroll_app_view({app, ref, direction, amount?})` gọi `scroll <ref> --direction <d> --amount <n>`. `amount` mặc định 3 và bị kẹp trong 1..20.
- Chỉ headless. Không có nhánh `--headed`, vì cuộn mà chiếm chuột của người dùng là thứ tay đã làm.
- Nếu `delivery` lỗi mà `retry` là `safe` thì thử lại một lần.
- Công tắc riêng, bật mặc định.
- Brief: "Muốn xem thêm thì cuộn rồi read hoặc scan lại; ref cũ có thể hết hạn."

**Test.**
- Argv đúng.
- `amount` bị kẹp.
- `direction` lạ bị từ chối.
- Tool tắt thì không có trong danh sách.

**Eval mới.**
- "Cuộn xuống trong Safari" → `scroll_app_view`, có thể sau `scan_app_controls`.
- "Đọc tiếp phần dưới" → `scroll_app_view` rồi `read_app_text`.

**Bàn giao cho iris-po:** thêm `scroll_app_view` vào `TAINT_GATED` trong `src/main/hooks.mjs:413`, `plugin-tools.selftest.mjs:114` và `docs/plugin-hooks-spec.md:292`. Đây là file của iris-core.

**Token ước tính:** +150 đến +200.

**Trạng thái 2026-11-21:** đã code, chưa commit. Bước 0 (TextEdit): 81–104 ms, `delivered_verified`; 1 bước = 10% vùng cuộn; scroll trên textfield trả `ACTION_NOT_SUPPORTED`, nên mô tả `ref` nói rõ là scrollarea. Scroll đã tới nơi luôn có `retry: unsafe`, nên chỉ thử lại khi lỗi có `retry: safe`. Eval cho thấy Gemini có lần gửi `ref: ""`, nên tool trả `INVALID_ARGS` bảo scan trước. Schema ~500 ký tự cộng một câu brief (~140 token, chưa đo theo T1). Eval `--runs 3`: hai case scroll 3/3, tổng 52/54 (Teams Gửi 2/3 vì mở Slack trước, Pages 2/3 chọn scan, không liên quan). Chưa đo Safari, Finder, VS Code. Còn chờ: `TAINT_GATED` (iris-po), số T1.

## 3. `window_id` cho app nhiều cửa sổ

**Vấn đề.** Chrome hay VS Code mở hai cửa sổ thì `snapshot` và `find` trả `AMBIGUOUS_TARGET`, kèm danh sách cửa sổ trong `error.details`. Hiện tool trả nguyên lỗi lên, và Gemini không có cách chọn.

**Bước 0.** Mở hai cửa sổ Chrome và hai cửa sổ TextEdit. Lưu nguyên JSON lỗi và output của `list-windows --app`, rồi xem `error.details` có `id` và `title` không. Kiểm upstream #703 có còn đúng với `open_or_focus_app` dùng `--activate` không.

**Thay đổi.**
- Thêm tham số `window_id` cho `scan_app_controls`, `find_app_control` và `read_app_text`, truyền xuống `--window-id`.
- Khi CLI trả `AMBIGUOUS_TARGET`, tool rút gọn `error.details` thành `windows: [{id, title}]`. Chỉ giữ tiêu đề cửa sổ, không thêm nội dung.
- Brief: "Gặp nhiều cửa sổ thì chọn theo tiêu đề người dùng nói, hoặc hỏi lại."
- Không thêm tool `list_windows` riêng. Danh sách cửa sổ đi kèm lỗi là đủ (xem §Chưa làm).

**Test.**
- Argv đúng khi có `window_id`.
- Lỗi `AMBIGUOUS_TARGET` từ CLI giả được rút gọn thành `windows`.

**Eval mới.** "Trong cửa sổ Chrome tên Gmail, đọc tiêu đề" với kết quả lỗi giả có hai cửa sổ → gọi lại với `window_id`. Eval hiện chỉ chấm lượt đầu, nên case này cần thêm kịch bản hai lượt. Nếu eval chưa hỗ trợ thì chỉ test bằng selftest.

**Token ước tính:** +60 đến +100.

**Trạng thái 2026-11-21:** đã code, chưa commit. Bước 0 (chỉ TextEdit): `AMBIGUOUS_TARGET` chỉ xảy ra khi không cửa sổ nào của app đang focus; `error.details.candidates` có `id` và `title`, id dùng thẳng cho `--window-id`. Tool trả `error: {code: "AMBIGUOUS_TARGET", windows: [{id, title}]}`, bỏ message, suggestion `list-windows` và mọi trường khác. `find_app_control` với menubar cũng truyền `window_id`. Eval vẫn một lượt nên kịch bản hai lượt chỉ có trong selftest. Schema +~300 ký tự gồm câu brief (~75 token, chưa đo theo T1). Eval `--runs 3`: 58/60 rồi 59/60 (Pages 2/3 chọn scan, như trước). Chưa thử Chrome thật, chưa thử `--window-id` cùng `--surface`.

## 4. `close_app`

**Vấn đề.** "Tắt VS Code đi" hiện phải đi tìm nút đóng (case eval đang mong `find_app_control` hoặc `scan_app_controls`). Cách này chậm và hay hỏng. `cmd+q` bị chặn đúng chủ ý. Agent-desktop có `close-app <APP>` để thoát êm, và `--force` để kill.

**Bước 0.** Chạy `close-app TextEdit` khi có file chưa lưu. Xem app hiện alert Save hay CLI báo gì, và đo V2.

**Thay đổi.**
- Tool mới `close_app({app, confirmed?})` gọi `close-app <app>`. Không bao giờ truyền `--force`.
- Luôn hỏi trước: chưa có `confirmed: true` thì trả `NEEDS_CONFIRMATION`, theo đúng đường `RISKY` của click.
- Không cho đóng chính open-iris và terminal: tên app khớp với danh sách cấm thì báo lỗi.
- Nếu app hiện alert lưu file thì trả về `surfaces` (nối với mục 1) để Gemini hỏi người dùng.
- Công tắc riêng, bật mặc định.
- Bỏ dòng brief "đóng app bằng nút đóng". Sửa case eval "Tắt Visual Studio Code đi" để mong `close_app`.

**Test.**
- Chưa xác nhận thì ra `NEEDS_CONFIRMATION` và CLI giả không bị gọi.
- Đã xác nhận thì argv đúng và không có `--force`.
- open-iris và Terminal bị từ chối.

**Eval:** "Tắt Visual Studio Code đi" → `close_app`. "Thoát Spotify" → `close_app`.

**Bàn giao cho iris-po:** thêm `close_app` vào `TAINT_GATED`, giống mục 2.

**Token ước tính:** +120 đến +180.

**Trạng thái 2026-11-21:** đã code, chưa commit. Bước 0 (TextEdit): không có file chưa lưu thì 136 ms; có file chưa lưu thì `TIMEOUT` sau ~5 s và alert vẫn mở, nên tool gọi `list-surfaces --app` và trả `DIALOG_OPEN` kèm `surfaces`. Schema ~380 ký tự (~95 token, chưa đo theo T1). Eval `--runs 3`: hai case close_app 3/3, tổng 47/48 (Pages 2/3 chọn scan, không liên quan). Còn chờ: `TAINT_GATED` (iris-po), số T1 trong `optimize-plan.md` §4.

## 5. Tổng token và nghiệm thu

- Ước tính tổng: +390 đến +600 token trên nền 1539. Đo thật theo T1 trước khi merge. Nếu vượt +600 thì rút gọn mô tả (T3) trước, rồi mới bỏ bớt enum.
- Nghiệm thu:
  - `pnpm test` xanh.
  - Eval `--runs 3` không tụt case cũ, và case mới đạt ít nhất 2/3.
  - Số V2 của `scroll_app_view` và `close_app` có trong §4.
  - Có dòng `done` trong `history.jsonl`.

**Đo 2026-11-21 (T1, gemini-3.8-live, `promptTokenCount` lượt đầu, 11 tool mặc định bật trừ tắt hết):** 2201 (+662) sau khi code xong, vượt cap; rút gọn câu chữ mới thêm (surface, window_id, scroll, câu brief) còn **2126 (+587)**. Eval `--runs 3` sau khi rút: 58/60. Pages chọn cỡ chữ 2/3, chạy lại `--runs 5` 4/5 (lần sai chọn `scan_app_controls`, lỗi cũ có từ trước). Safari đọc tiếp 2/3 (một lần `read_app_text` trước khi cuộn), chạy lại 5/5. Case 15 (Don't Save) 3/3; nếu Gemini bỏ `surface`, `find_app_control` không thấy gì trong cửa sổ sẽ tự tìm lại với `surface: focused`. Số §4 của `optimize-plan.md` và V2 chờ iris-po.

## 6. Đã tìm hiểu nhưng chưa làm

Trước khi đề xuất thêm tool, tra ở đây xem đã xét chưa. Mỗi dòng ghi lý do và bằng chứng nào thì nên làm.

| Khả năng (lệnh agent-desktop) | Vì sao chưa làm | Làm khi |
|---|---|---|
| `screenshot` | Gửi ảnh màn hình là rủi ro riêng tư (dễ lộ terminal, app khác) và tốn nhiều token. Cây AX là đủ cho phần lớn việc. | App chỉ có canvas hoặc ảnh, không có AX (game, Figma canvas), và log cho thấy scan trống nhiều lần. Phải giới hạn vào đúng cửa sổ app, không cả màn hình. |
| `clipboard-get` / `clipboard-set` | Clipboard hay chứa mật khẩu và token. Đọc nó là rò rỉ ngoài app được nêu tên. | Người dùng xin rõ ràng và có công tắc riêng tắt mặc định. Tốt nhất làm plugin. |
| `drag`, `hover`, `mouse-click` theo toạ độ | Tay đã làm việc này (pinch, kéo). Case eval "Kéo file ảnh..." chủ ý mong không gọi tool. | Có người dùng không dùng được tay, hoặc log cho thấy nhiều lần nhờ tay kéo thất bại. |
| `check`, `uncheck`, `toggle`, `expand`, `collapse` | `click_app_control` đã đủ cho checkbox, switch và disclosure trong các test đến nay. | Log có click vào checkbox mà trạng thái không đổi, hoặc verify báo sai lặp lại. |
| `right-click`, `double-click`, `triple-click` | Chưa có ca thật. Menu chuột phải có thể thay bằng menubar (mục 1). | Ca thật cần mở file bằng double-click, hoặc menu ngữ cảnh không có trong menubar. |
| `scroll-to @ref` | `scroll_app_view` cộng scan lại là đủ. Ref ngoài màn hình thường không có trong cây ảo hoá. | Log cho thấy ref có trong cây mà click lỗi vì nằm ngoài màn hình. |
| Surface `notification-center`, `dock`, `spotlight`, `menu-bar-extras`, `system-tray` | Không thuộc app được nêu tên, mà là phạm vi hệ thống. Thông báo có thể chứa tin nhắn riêng. | Làm plugin (ví dụ đọc thông báo) với công tắc riêng. Không đưa vào core. |
| `wait`, `--wait-for` | Tool đã tự chờ qua `--timeout-ms`. Chờ dài làm Live im lặng. | App chậm (Electron lạnh 10–25 s) làm scan trả `complete: false` nhiều lần. |
| `launch --cdp` (Chrome DevTools) | Mở cổng debug là rủi ro bảo mật, và trùng với AX cho phần lớn việc. | Cần thao tác web sâu mà AX không thấy. Phải qua iris-security trước. |
| Tool `list_windows`, `focus-window`, đổi cỡ cửa sổ | `window_id` kèm danh sách trong lỗi (mục 3) là đủ. Đổi cỡ cửa sổ không phải nhu cầu đã thấy. | Người dùng hay nói "chuyển sang cửa sổ kia", hoặc lỗi `AMBIGUOUS_TARGET` không mang theo `details`. |
| `close-app --force` | Kill app có thể mất dữ liệu chưa lưu. | Không làm qua giọng nói. Người dùng tự dùng Force Quit. |

**Lỗi nhỏ đã thấy ngày 2026-11-21, chưa sửa, chờ duyệt riêng:**
- `searchBox()` kiểm `role === "searchfield"`, nhưng CLI gộp searchfield vào `textfield`, nên nhánh đó không bao giờ chạy. Selftest dòng 85 dùng role giả. Chỉ còn regex theo tên là có tác dụng.
- `readText` bỏ qua `data.complete`. Cây chưa đủ (Electron lạnh) mà Gemini tưởng đã đọc hết. Nên trả `complete: false` kèm gợi ý đọc lại.
- Nhánh `type --interval-ms` trong `TYPE_WAYS` không xoá ô trước khi gõ. Nếu nhánh trước đã gõ một phần thì chữ bị lặp.
- Comment về `press`: CLI luôn gửi phím vật lý, kể cả không có `--headed`. Comment hiện tại ngụ ý là headless.
- Mô tả `find_app_control` nêu role `searchfield` hoặc `textarea`, nhưng CLI gộp cả hai vào `textfield`.
- `list_running_apps` trả cả tiến trình nền (helper, agent). Nên lọc để đỡ token.

**Issue upstream đang mở, liên quan:**
- [#703](https://github.com/vercel-labs/agent-desktop/issues/703): `launch` không có `--activate` thì ra `AMBIGUOUS_TARGET`. Mình dùng `--activate` nên tránh được; nếu bỏ cờ đó thì phải xem lại.
- [#656](https://github.com/vercel-labs/agent-desktop/issues/656): `list-apps` TIMEOUT trên macOS 26.6.1. Máy này chạy được. Nếu người dùng báo `list_running_apps` treo thì nghĩ đến issue này trước.
- [#674](https://github.com/vercel-labs/agent-desktop/issues/674): click menubar của app Electron có thể im lặng không làm gì. Đây là rủi ro của mục 1 với VS Code và Slack. Kiểm ở bước 0.

**Lệch chủ ý khỏi hướng dẫn upstream:** guide của agent-desktop nói không chuyển sang headed để cứu lỗi headless. Mình vẫn có nhánh `type --headed` cuối cùng trong `TYPE_WAYS`, vì người dùng đã đồng ý ngày 2026-11-18. Tool mới trong plan này không thêm nhánh headed nào.
