# Kế hoạch: tắt plugin giữa phiên thì tắt thật, và log cho biết plugin góp gì

Ngày 2026-11-20. Trạng thái: **user đã duyệt, U1–U4 xong** (`pnpm test` qua), U5 chưa chạy. Người làm: iris-core. Chỉ đụng `src/main/hooks.mjs` và `src/main/hooks.selftest.mjs`.

Nguồn ý tưởng: DeepSeek Harness (Cordis) gỡ mọi thứ plugin đăng ký khi nó bị tắt, và có `--dump-config` in ra những gì đang chạy. Mình chỉ lấy hai ý này. Không lấy model, loop hay session thành plugin, không lấy sandbox, không lấy registry.

## 1. Lỗi: tắt giữa phiên mà vẫn chạy

Đã chạy lại bằng script thử, gọi `createHooks` với đồng hồ giả:

```
A speak after group off: SENT SYSTEM_EVENT_HOOK p/g: hi
B tool call after tool off: SPAWNED ok=true
```

| # | Khi người dùng tắt… | Bây giờ | Sau khi sửa |
|---|---|---|---|
| A | nhóm hook có `speak` đang chờ trong hàng | vẫn nói, có thể tới 60 giây sau | bỏ lượt đó, ghi log |
| A' | nhóm `Tick` có command đang chạy dở | chạy xong vẫn xếp `speak` | bỏ, cùng cách sửa với A |
| B | tool `command` (hoặc cả plugin) | `prune()` kill process `late`, nhưng Gemini gọi lại thì script vẫn chạy | trả `{error: "tool switched off by the user"}`, không spawn |
| C | tool có kết quả `late` đang chờ nói (`later()`) | vẫn nói | bỏ, ghi log |

**Không đổi:**
- Context `SessionStart`, `brief` và khai báo tool đã gửi cho Gemini vẫn còn tới lần Bắt đầu sau, vì Gemini không cho rút lại.
- Bật một nhóm `Tick` giữa phiên, hay đổi `every_min` giữa phiên, chỉ có tác dụng từ lần Bắt đầu sau. Giữ nguyên, vì đây là cách đang làm và không gây hại.
- Gỡ plugin giữa phiên: config bị xoá thì `isOn` trả false, nên dùng chung cách sửa.

**Nguyên nhân:**
- Hàng `pending` và `runTool` không đọc lại công tắc.
- Chỉ `active()` đọc lại công tắc, và nó chỉ chạy lúc một sự kiện được kích.

**Cách sửa** (`hooks.mjs`, khoảng 10 dòng):
1. Thêm hàm `isOn(plugin, kind, name)`. `kind` là `groups` hoặc `tools`. Hàm đọc `getConfig()` và trả `config[plugin]?.on && config[plugin][kind]?.[name]?.on`.
2. Mỗi mục trong `pending` mang theo `plugin`, `kind` và `name`.
   - `say()` nhận các giá trị này từ nhóm hook.
   - `later()` lấy `plugin` và tên tool từ `sessionTools`.
   - `loop()` gặp mục đã tắt thì bỏ, ghi `hook <id>: switched off, speak dropped` rồi xét mục kế tiếp.
3. `runTool` gọi `isOn` **đầu tiên**, trước bước xác nhận. Tool đã tắt thì không hỏi xác nhận, không kiểm tra args, không spawn.
4. Không đổi `prune()`. Mục `late` đang chờ đã có bước 2 lo.

**Đối chiếu `history.jsonl`:** `2026-11-20-core-plugin-process-group` sửa phần kill process và `2026-11-20-core-taint-plugin-tools` sửa phần chặn khi tainted. Bản sửa này chỉ thêm một bước kiểm tra trước, không đụng hai chỗ đó. Thứ tự trong `runTool` là: công tắc → confirm → args → trust → spawn.

## 2. Log: plugin nào góp gì

**Hiện có:**
- `connecting … plugins=<tên>`;
- `settings <plugin> {…}` mỗi lần bấm công tắc;
- `hook sent <id>`;
- dòng báo context vượt 4000 ký tự, chỉ ghi khi đã vượt.

**Thêm hai dòng.** Chỉ ghi tên và số, không ghi chữ của hook, để excerpt đưa vào `ops-logs/` không phải xoá gì.

```
[plugins] session groups=livestream/brief@SessionStart,livestream/recap@Tick/5m tools=orca__start_job context=1240/4000 dropped=0
[plugins] hook livestream/brief context +312 chars on SessionStart
[plugins] hook orca/guard context +80 chars on PreToolCall click_app_control
```

- Dòng `session` ghi một lần trong `emit("SessionStart")`, sau khi đã cắt theo `SESSION_CONTEXT_MAX`. `groups` là mọi nhóm đang bật (kèm `every_min` thật của `Tick`), `tools` là `sessionTools`. Dòng này thay cho dòng "over 4000" hiện có, vì `dropped` đã nói điều đó.
- Dòng `hook … context +N chars` ghi trong `emit` cho mỗi nhóm có context, ở mọi sự kiện có context.

## 3. Các bước

Mỗi bước kết thúc bằng `pnpm test` qua. Không commit; iris-po commit khi user bảo.

| # | Việc | Kiểm chứng |
|---|---|---|
| U1 | Thêm ca A, B, C vào `hooks.selftest.mjs` | Chạy trước khi sửa: cả ba **fail** |
| U2 | Sửa theo mục 1 | A, B, C pass. Toàn bộ `pnpm test` pass |
| U3 | Thêm ca cho log ở mục 2 | Fail trước khi sửa. Sau khi sửa: dòng `session` có đúng tên nhóm, `@Tick/5m`, `context=N/4000`, `dropped`; không dòng log nào chứa chữ của hook (dùng một chuỗi đánh dấu như `SECRET_TEXT`) |
| U4 | Sửa theo mục 2 | U3 pass, `pnpm test` pass |
| U5 | `pnpm dev`, bật livestream, Bắt đầu, tắt nhóm `recap` | `main.log` có dòng `session`, và không có `hook sent livestream/recap` sau khi tắt |

## 4. Rủi ro

- `isOn` đọc `config.json` mỗi giây trong `loop()`, nhưng chỉ khi hàng `pending` có mục. Đây là chi phí nhỏ, và `active()` cũng đã đọc kiểu này ở mỗi sự kiện.
- `hooks.mjs` và `main.mjs` đang có thay đổi chưa commit của việc khác. Bản sửa này không đụng `main.mjs`.

## 5. Ghi vào `ops-logs/history.jsonl`

Hai dòng `proposed`: `2026-11-20-core-plugin-off-midsession` (mục 1) và `2026-11-20-core-plugin-context-log` (mục 2). Khi user duyệt, iris-po ghi thêm dòng `approved`.
