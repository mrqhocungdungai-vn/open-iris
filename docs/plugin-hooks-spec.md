# Đặc tả: hook cho plugin (đăng ký với harness open-iris)

Ngày 2026-11-20. Trạng thái: **đã duyệt** (2026-11-20, chốt mục 11 theo đề xuất), đang làm H1–H3.

Spec này thay dòng "không process plugin, không background task" ở `docs/plugin-pack-plan.md` mục 1, và thay `tasks.json` ở `docs/livestream-plugin-plan.md`. Hợp đồng hook lấy theo `docs/plugin-plan.md` mục 4.3 (giống Claude Code). MCP vẫn để ở P3.

## 1. Mục tiêu và tiêu chí

- Tính năng bên ngoài gắn vào open-iris bằng hook mà **không sửa code lõi**. Có hook thì lõi chạy, không có thì thôi.
- Kiểm chứng: viết lại Livestream thành plugin chỉ dùng hook, và `src/main` không còn dòng nào riêng cho livestream (`grep -rniE "livestream|recap|cta|topic|goal" src/main` không còn kết quả).
- Không có hai hệ chạy song song: `tasks.json` bị bỏ, thay bằng sự kiện `Tick`.

## 2. Đăng ký: `plugin.json`

```json
{
  "name": "livestream",
  "version": "0.2.0",
  "open_iris_api": 1,
  "description": "Iris làm đồng dẫn livestream...",
  "fields": [
    { "key": "topic", "label": "Chủ đề", "label_en": "Topic", "max": 200, "hint": "..." }
  ],
  "components": {
    "hooks": "./hooks/hooks.json"
  }
}
```

- `components` liệt kê tường minh những gì plugin đăng ký. Loader **chỉ** đọc các đường dẫn ghi ở đây, không tự dò file.
  - Bản này hỗ trợ khoá `hooks` và `tools` (chỉ tool loại `command`, mục 12).
  - Các khoá `skills`, `gestures`, `apps` và tool ghép dành cho plugin-pack-plan và được làm sau.
  - Gặp khoá lạ thì plugin hỏng kèm lý do, để không có cảm giác "đã cài mà chẳng có gì chạy".
- Đường dẫn phải nằm trong thư mục plugin: bắt đầu bằng `./`, không có `..`, không phải symlink ra ngoài.
- `fields` giữ như hiện tại: tối đa 5 ô một dòng, giá trị lưu ở `~/.open-iris/config.json`.
- **Phiên bản (đề xuất, chờ duyệt):**
  - Thêm `"version"` vào `package.json` của open-iris.
  - Lõi khai `PLUGIN_API = 1` trong `hooks.mjs`.
  - Plugin khai `open_iris_api` là số nguyên. Nếu số đó lớn hơn `PLUGIN_API` thì plugin hỏng với lý do "cần open-iris mới hơn".
  - API chỉ tăng khi hợp đồng thay đổi theo kiểu làm hỏng plugin cũ. Thêm sự kiện mới thì không tăng.

## 3. `hooks.json`

Cùng dạng với Claude Code: sự kiện → danh sách nhóm, mỗi nhóm có `matcher` và danh sách hook.

```json
{
  "hooks": {
    "SessionStart": [
      { "name": "brief", "label": "Vai đồng dẫn", "label_en": "Co-host role",
        "hooks": [ { "type": "context", "text": "Livestream mode: ... Today's topic: {topic}." } ] }
    ],
    "Tick": [
      { "name": "recap", "label": "Tóm tắt định kỳ", "label_en": "Periodic recap", "every_min": 5,
        "hooks": [ { "type": "speak", "text": "Recap the last few minutes... ({topic})." } ] },
      { "name": "cta", "label": "Kêu gọi hành động", "label_en": "Call to action", "every_min": 7,
        "hooks": [ { "type": "speak", "text": "Give one call to action... {goal}." } ] }
    ],
    "PreToolCall": [
      { "name": "no-banking", "label": "Chặn app ngân hàng", "matcher": "open_or_focus_app|click_app_control",
        "hooks": [ { "type": "command", "command": "node ./hooks/block-bank.mjs", "timeout": 3 } ] }
    ]
  }
}
```

- **Nhóm:**
  - `name` có dạng `[a-z0-9-]`, không trùng trong plugin. Id đầy đủ là `<plugin>/<name>`, dùng cho công tắc, log và `every_min` người dùng đặt.
  - Mỗi nhóm có một công tắc riêng, cài xong mặc định **tắt**.
  - `matcher` là regex trên tên tool, chỉ dùng cho `PreToolCall`/`PostToolCall`. Bỏ trống nghĩa là mọi tool.
  - `every_min` (2–60) chỉ dùng cho `Tick` và bắt buộc ở đó. Người dùng chỉnh được trong tab Plugin.
- **Ba loại hook:**

| `type` | Là gì | Cần tin cậy | Kết quả |
|---|---|---|---|
| `context` | Đoạn chữ (tối đa 1000 ký tự), thay `{field}` | Không | Thêm vào ngữ cảnh của Gemini, Iris không nói gì |
| `speak` | Đoạn chữ (tối đa 1000 ký tự), thay `{field}` | Không | Gửi thành lượt `SYSTEM_EVENT_HOOK <id>: <text>` để Iris nói ra loa |
| `command` | Lệnh shell, hợp đồng ở mục 5 | **Có** (mục 6) | Từ stdout: thêm ngữ cảnh, nói, hoặc chặn |

- Câu nào chứa `{field}` đang trống thì bị bỏ, như `fill()` hiện tại. `{key}` không khai trong `fields` thì plugin hỏng.
- Giới hạn: 20 nhóm mỗi plugin, 5 hook mỗi nhóm.
- Tổng context `SessionStart` của mọi plugin tối đa 4000 ký tự (`SESSION_CONTEXT_MAX`), vì nó nằm trong system instruction suốt phiên. Quá trần thì giữ nguyên từng đoạn theo thứ tự plugin, bỏ các đoạn sau và ghi log.

## 4. Sự kiện

| Sự kiện | Khi nào | `context` đi đâu | `speak` | `command` chặn được? |
|---|---|---|---|---|
| `SessionStart` | Trước `ai.live.connect` | Nối vào system instruction | Không dùng (plugin hỏng) | Không |
| `SessionEnd` | `onclose` hoặc Stop | Không dùng | Không dùng | Không |
| `UserTurn` | Hết một câu người dùng nói (gom `inputTranscription` tới khi `turnComplete`) | `sendClientContent(turnComplete:false)` | Có | Không |
| `IrisTurn` | Iris nói xong một lượt (`turnComplete`) | như trên | Có | Không |
| `PreToolCall` | Trước khi chạy mỗi tool call, sau bước kiểm tra 👂 | Thêm vào phản hồi tool | Không | **Có**: tool không chạy, Gemini nhận `{error: reason}` |
| `PostToolCall` | Sau khi tool chạy xong, trước `sendToolResponse` | Thêm vào phản hồi tool | Không | Không |
| `ListenOnlyChanged` | Bật hoặc tắt 👂 | `sendClientContent(turnComplete:false)` | Không | Không |
| `Tick` | Đến chu kỳ `every_min` của nhóm | Không dùng | Có (thường dùng) | Không |

- **Luật `speak` và `Tick`:** lõi giữ những luật này, plugin không đổi được. Đây là bộ lập lịch trong `tasks.mjs`, dùng chung cho mọi lần nói chủ động.
  - Chỉ nói khi không ai nói trong 4 giây.
  - Hai lần nói chủ động cách nhau ít nhất 60 giây.
  - Đang 👂 hoặc chưa có phiên thì **giữ lượt** tới khi nói được.
  - Nhiều lượt cùng tới hạn thì lượt trễ lâu nhất nói trước.
- `Tick` chỉ chạy khi có phiên. Chu kỳ tính từ lúc `onopen`. Khi "Giữ phiên dài" nối lại sau đứt kết nối, đó vẫn là một phiên: `SessionStart`/`SessionEnd` không bắn lại và `Tick` giữ nguyên bộ đếm (docs/session-plan.md).
- Hook `UserTurn` và `IrisTurn` không được làm chậm hội thoại: chúng chạy song song và không chặn luồng âm thanh.

## 5. Hook `command`: hợp đồng giống Claude Code

- Chạy bằng `spawn` qua `/bin/sh -c`, ở **process riêng**, không bao giờ chạy trong main process.
  - `cwd` là thư mục plugin.
  - Env tối thiểu: `PATH`, `HOME`, `IRIS_PLUGIN_ROOT`, `IRIS_PLUGIN_DATA=~/.open-iris/plugin-data/<plugin>/`.
  - Không truyền `GEMINI_API_KEY` hay bất kỳ biến môi trường nào khác của app.
  - `PATH` = `PATH` của app, thêm `/opt/homebrew/bin` và `/usr/local/bin` nếu chưa có. Không mở login shell. App mở từ Finder chỉ có `/usr/bin:/bin:/usr/sbin:/sbin`, nên đây là cách để tìm thấy `node` cài bằng Homebrew. Giới hạn: `node` cài bằng nvm/asdf vẫn không thấy; hướng nâng cấp là một ô `PATH` trong tab Plugin.
- **stdin** là một object JSON:
  ```json
  { "event": "PreToolCall", "plugin": "livestream", "hook": "livestream/recap",
    "session_id": "…", "settings": { "topic": "…", "goal": "…" }, "lang": "vi",
    "tool": { "name": "click_app_control", "args": { … } },
    "text": "…" }
  ```
  - `tool` chỉ có ở Pre/PostToolCall. Ở PostToolCall có thêm `result`.
  - `text` chỉ có ở UserTurn/IrisTurn.
  - `listen_only` chỉ có ở ListenOnlyChanged.
- **Kết quả:**
  - `exit 0`: thành công. Nếu stdout là JSON, lõi đọc các trường sau (tất cả tuỳ chọn):
    ```json
    { "decision": "block", "reason": "…",
      "hookSpecificOutput": { "hookEventName": "PreToolCall", "additionalContext": "…" },
      "speak": "…" }
    ```
    - `decision: "block"` chỉ có tác dụng ở `PreToolCall`.
    - `additionalContext` và `speak` mỗi trường tối đa 1000 ký tự. Phần dư bị cắt.
    - `speak` theo luật giữ lượt ở mục 4.
    - stdout không phải JSON thì bỏ qua và ghi log.
  - `exit 2`: chặn, stderr là lý do. Ở sự kiện không chặn được thì chỉ ghi log.
  - Mã thoát khác: lỗi, ghi log kèm stderr.
- **Thời gian chờ:** `timeout` mặc định 3 giây, tối đa 10 giây (riêng `Tick` tối đa 30 giây). Quá giờ thì `SIGKILL`.
- **Fail closed:** ở `PreToolCall`, hook lỗi, quá giờ hoặc chưa được tin cậy thì **chặn** tool, kèm lý do. Ở sự kiện khác, hook lỗi thì không có tác dụng gì và chỉ ghi log.
- stdout và stderr đọc tối đa 64 KB.
- Chữ đi tới Gemini (`additionalContext`, `speak`) vẫn qua luật lõi "terminal không tới Gemini". Ghi rõ trong tài liệu cho người viết plugin là không được đọc màn hình terminal.

## 6. Cổng tin cậy

- Plugin có ít nhất một hook `command` thì khi **bật** sẽ hiện hộp thoại liệt kê:
  - từng lệnh,
  - sự kiện và `matcher` của lệnh,
  - dữ liệu lệnh sẽ nhận (ví dụ: "lời bạn nói" với UserTurn, "tên và tham số tool" với PreToolCall).

  Có hai nút: Tin cậy và Huỷ.
- Đồng ý được lưu ở `~/.open-iris/trust.json`, dạng `{ "<plugin>": "<sha256>" }`.
  - Mã băm tính trên **toàn bộ file trong thư mục plugin**, đi theo thứ tự tên. Băm cả file script, vì script đổi mà lệnh giữ nguyên thì vẫn là code mới.
  - Mã băm đổi (cập nhật plugin hoặc sửa script) thì hook `command` ngừng chạy, thẻ plugin hiện "cần tin cậy lại", và phải hỏi lại.
  - Lõi **băm lại trước mỗi lần chạy** hook `command` (như tool ở 12.5), không chỉ lúc bắt đầu phiên. Script bị sửa giữa phiên thì hook không chạy; ở `PreToolCall` thì chặn (fail closed).
- **Symlink:** symlink trỏ ra ngoài thư mục plugin (sau khi phân giải đường thật) hoặc symlink hỏng thì plugin bị từ chối lúc nạp, lúc cài, và lúc tính mã băm, kể cả symlink không thành phần nào dùng tới. Lý do: mã băm chỉ băm chữ của link, nên code ngoài thư mục có thể đổi mà mã băm vẫn khớp. Symlink trỏ vào trong thư mục plugin thì được.
- Hook `context` và `speak` không cần tin cậy, vì chúng không chạy code. Chúng vẫn cần công tắc bật và vẫn chịu giới hạn độ dài.

## 7. Thứ tự và hook lõi

- Hook plugin chạy trước, hook lõi chạy **cuối cùng** và plugin không tắt được:
  - `RISKY` → `NEEDS_CONFIRMATION` (`desktop.mjs`);
  - luật terminal.
- Riêng việc từ chối tool khi 👂 chạy **sớm hơn**, trước `PreToolCall`: khi Iris phải im thì cả lượt tool bị từ chối và không hook plugin nào chạy. Plugin cũng không tắt được bước này.
- Hook plugin chỉ **thêm** được hạn chế, không bỏ được hạn chế nào. `PreToolCall` không có cách nào để "cho qua" một thao tác mà lõi chặn.
- Trong cùng một sự kiện: plugin chạy theo thứ tự tên, nhóm chạy theo thứ tự trong file. Ở `PreToolCall`, hook đầu tiên chặn thì dừng luôn.

## 8. Thay đổi trong lõi (giữ `main.mjs` gọn vì open-iris-dev đang sửa cùng file cho orb)

- `src/main/tasks.mjs` → `src/main/hooks.mjs`, gồm:
  - `parsePlugin`: `components`, `open_iris_api`, `hooks.json`;
  - `loadPlugins`, `fill`;
  - `runCommand(hook, input, {spawn, timeoutMs})`;
  - `trustHash(dir)`;
  - `createScheduler` (giữ nguyên);
  - `createHooks({plugins, config, trust, send, …})`, trả về `emit(event, payload)`. Main chỉ gọi `emit` ở 8 chỗ.
- `main.mjs`: thay code `tasks` hiện tại bằng khoảng 8 lời gọi `hooks.emit(...)`. Không có chữ "livestream".
- `preload.cjs`: giữ `savePlugin`, thêm `trustPlugin(name)`.
- `tasks.json` và `SYSTEM_EVENT_TASK` bị bỏ.

**IPC cho tab Plugin** (đã thống nhất với open-iris-dev, người làm UI):
- `plugins:list` → mỗi plugin là `{ name, version, description, api, error?, on, fields, groups, trust }`:
  - `fields`: `[{ key, label, label_en, hint, max, value }]`.
  - `groups`: `[{ id, name, event, label, label_en, on, every_min?, every_min_default?, kinds, commands }]`.
  - `trust`: `null`, hoặc `{ approved, changed, commands: [{ group, event, matcher, command, receives }] }`.
  - `tools`: `[{ id, name, label, label_en, on, confirm, late, command }]` (mục 12). `trust.commands` có thêm một dòng cho mỗi tool, với `event: "ToolCall"` và `tool: <name>`.
- `config:plugin` (`savePlugin`) nhận `{ name, on?, fields?, groups?: { [name]: { on?, every_min? } }, tools?: { [name]: { on? } } }`. Main kiểm tra và kẹp giá trị.
- `plugins:trust(name)`: renderer chỉ gửi tên. Main tự băm thư mục và ghi vào `~/.open-iris/trust.json`, rồi trả về plugin đã cập nhật.
- `plugins:open` giữ như cũ. **Chưa có** cài từ URL: hiện cài bằng `install.sh` của repo open-iris-plugins.

## 9. Các bước

Mỗi bước kết thúc bằng `pnpm test` qua. Chỉ commit khi user bảo.

| # | Việc | Kiểm chứng |
|---|---|---|
| H1 | `hooks.mjs`: parse `plugin.json`/`hooks.json`, `components`, `open_iris_api`, giới hạn | `hooks.selftest.mjs`: thiếu khoá, khoá lạ, đường dẫn `..`, `{key}` lạ, `speak` ở SessionStart, API quá mới đều bị từ chối kèm lý do |
| H2 | `runCommand` + `trustHash` | Selftest dùng script thật trong thư mục tạm: `exit 2` → chặn kèm stderr; script treo → quá giờ thì chặn; stdout JSON → `additionalContext`/`speak`; env không có `GEMINI_API_KEY`; sửa 1 byte script → mã băm đổi |
| H3 | `createHooks().emit` + scheduler cho `Tick`/`speak` | Đồng hồ giả: recap 5 phút, cta 7 phút, cách 60 giây, giữ lượt khi 👂, PreToolCall chặn thì tool không chạy, hook lõi vẫn chạy cuối |
| H4 | Gắn vào `main.mjs` (8 chỗ `emit`), xoá `tasks.mjs` | `grep` ở mục 1 sạch. `pnpm dev` + livestream: brief có topic, recap được nói sau khoảng 5 phút |
| H5 | Tab Plugin: công tắc theo nhóm hook, `every_min`, hộp thoại tin cậy. **Xem trước HTML trước** | User duyệt bản xem trước, rồi thử bật plugin có `command` |
| H6 | Repo `open-iris-plugins`: livestream 0.2.0 dùng `hooks.json`, validator, CLAUDE.md, README, thêm 1 plugin mẫu có `command` (chặn app trong danh sách) | `node scripts/index.mjs` ok, cài bằng `install.sh` rồi chạy được |

## 10. Rủi ro

- **Hook `command` là code lạ chạy với quyền của user.** Giảm bằng cổng tin cậy theo mã băm, env tối thiểu, timeout và giới hạn kích thước stdout. Hook không bị sandbox, và hộp thoại phải nói rõ điều đó.
- **Lộ lời nói:** hook ở UserTurn/IrisTurn nhận nguyên văn hội thoại. Hộp thoại tin cậy phải ghi rõ, và mặc định tắt.
- **Độ trễ:** `PreToolCall` chạy trước mỗi tool, nên chậm thêm tối đa bằng timeout. Log ghi thời gian chạy của từng hook.
- **Gemini đóng phiên sau khoảng 10 phút** (L0, làm riêng). `Tick` chỉ chạy trong phiên, nên trước khi có L0 thì livestream dài phải bấm Start lại.

## 11. Câu hỏi cần user chốt

1. Cách đánh phiên bản ở mục 2: `open_iris_api` là số nguyên, cộng thêm `"version"` trong package.json?
2. Mã băm tin cậy tính trên toàn bộ thư mục plugin (an toàn hơn), hay chỉ trên các dòng lệnh (ít phải hỏi lại hơn)? Đề xuất: **toàn bộ thư mục**.
3. Cho phép hook `command` ở `UserTurn`/`IrisTurn` ngay từ bản đầu, hay chỉ cho hook `context`/`speak` ở đó và để bản sau? Đề xuất: **cho phép, mặc định tắt, hộp thoại ghi rõ**.

## 12. Tool `command` (`components.tools`)

Đã chốt 2026-11-20 (pack-plan §6.3, orca-plugin-plan K1–K4). Lõi chỉ có API chung, không biết plugin nào.

### 12.1 `tools.json`

`plugin.json` → `"components": { "tools": "./tools/tools.json" }`:

```json
{
  "tools": [
    { "name": "start_job", "label": "Chạy việc", "label_en": "Start a job",
      "description": "Start a long job. Returns 'started' at once; the result arrives later.",
      "parameters": { "type": "object", "properties": { "text": { "type": "string", "description": "What to do" } }, "required": ["text"] },
      "brief": "Call demo__start_job only for long jobs.",
      "command": "node ./tools/job.mjs", "timeout": 20, "late": { "timeout_min": 30 }, "confirm": false }
  ]
}
```

- `name`: `[a-z0-9_]`, tối đa 40 ký tự, không trùng. Gemini thấy tên `<plugin>__<name>` (tối đa 64 ký tự). `matcher` của `PreToolCall`/`PostToolCall` khớp trên tên đầy đủ này, và `brief` cũng nên viết tên đầy đủ.
- `description` (tối đa 1000 ký tự) và `brief` viết tiếng Anh. `label` tiếng Việt, `label_en` tiếng Anh (tối đa 80).
- `parameters`: `{ "type": "object", "properties": {…}, "required": […] }`. Mỗi thuộc tính là `string`, `boolean` hoặc `number`, có `description` tuỳ chọn; riêng `string` được có `enum` (danh sách chuỗi). Tối đa 10 thuộc tính, tên theo `[a-z][a-z0-9_]`. Kiểu khác, khoá lạ, hoặc thuộc tính tên `confirmed` thì plugin hỏng kèm lý do.
- `brief` tối đa 300 ký tự. Chỉ vào system instruction khi tool **bật**, và tính chung vào `SESSION_CONTEXT_MAX` (sau context `SessionStart` của hook).
- `command`: như hook `command` (mục 5). `timeout` mặc định 10 giây, tối đa 30 giây.
- `late` (tuỳ chọn): `{ "timeout_min": 1–30 }`, bắt buộc có `timeout_min`. Xem 12.3.
- `confirm: true`: lõi thêm tham số `confirmed` (boolean) và trả `NEEDS_CONFIRMATION` khi nó không phải `true`, như luật `RISKY` của tool desktop. Script không chạy.
- **Trần:** tối đa **8** tool `command` mỗi plugin. Tính riêng với trần 20 của tool ghép (pack-plan §4), vì tool `command` chạy code lạ sau cổng tin cậy còn tool ghép chỉ gọi 9 tool desktop.

### 12.2 Chạy

- Công tắc: `config.json` → `plugins.<plugin>.tools.<name>.on`. Mọi tool bắt đầu ở trạng thái tắt; `tools.json` không có cách bật sẵn.
- Gemini chỉ thấy tool khi plugin bật, tool bật **và** plugin được tin cậy (cùng mã băm thư mục với hook `command`, mục 6). Danh sách tool và `brief` chốt lúc bấm Bắt đầu, như tool desktop.
- Lời gọi đi qua đường tool chung: luật 👂 trước, rồi `PreToolCall`, rồi tool, rồi `PostToolCall`.
- Process riêng, `/bin/sh -c`, `cwd` là thư mục plugin, env như mục 5 (không có `GEMINI_API_KEY`).
- **stdin:** `{ "event": "ToolCall", "plugin": "demo", "tool": { "name": "start_job", "args": {…} }, "settings": {…}, "lang": "vi", "session_id": "…" }`. `args` do Gemini tạo từ lời nói nên là **dữ liệu không đáng tin**: script truyền chúng như dữ liệu (`execFile`), không ghép vào lệnh shell.
- **stdout:** dòng JSON đầu tiên là `{ "output": … }` hoặc `{ "error": … }` (chuỗi, hoặc JSON bất kỳ và lõi đổi thành chuỗi). Tool không có `late`: lõi chờ process thoát rồi đọc dòng JSON đầu. Exit khác 0, quá giờ, hoặc không có dòng JSON → lỗi kèm lý do ngắn.

### 12.3 Kết quả đến sau (`late`)

- Tool có `late` được khai `NON_BLOCKING`. Lõi gửi dòng đầu ngay khi script in ra, kèm `willContinue: true`, và không chờ process thoát.
- Dòng JSON thứ hai được gửi với `scheduling: WHEN_IDLE` (`SILENT` khi đang 👂), cho cùng `id` lời gọi. Sau đó script nên thoát.
- Lõi kill process (cả nhóm process) khi:
  - dòng đầu chưa có sau `timeout` giây (lỗi "timed out");
  - hết `late.timeout_min` phút mà chưa có dòng hai (gửi `{ error: "timeout" }`);
  - Gemini huỷ lời gọi (`toolCallCancellation`);
  - `SessionEnd`, phiên mới, ↺ xoá, hoặc thoát app;
  - plugin hay tool bị tắt, hoặc plugin bị gỡ.
- Khi script (tool hay hook `command`) thoát bình thường, lõi cũng kill cả nhóm process của nó, để process con chạy nền không sống tiếp. Hook `command` còn đang chạy bị kill khi thoát app.
- Giới hạn đã biết: process cháu gọi `setsid()` sẽ rời nhóm process và thoát được mọi lần kill. Lõi chưa chặn việc này; sẽ nâng lên launchd job hay sandbox riêng cho plugin nếu thấy plugin làm vậy.
- Dòng đầu là lỗi thì process bị kill, không có dòng hai.
- Kết nối đã đổi do nối lại hay resume (cùng cuộc trò chuyện): dòng hai không thành `toolResponse` mà thành một lượt text của client trong kết nối hiện tại, mở đầu `[plugin tool result]`, ghi rõ là dữ liệu plugin, giữ nguyên `{ plugin_output, from }`. Vẫn qua lọc (12.4) và `PostToolCall`. Iris nói ra khi im lặng như hook `speak` (giống `WHEN_IDLE`); đang 👂 thì gửi im lặng. Vẫn bật cờ tainted (12.6).
- ↺ hay phiên mới: process `late` đã bị kill nên không có dòng hai; dòng hai đang xử lý dở hay đang chờ nói thì bị bỏ và ghi log.
- Mỗi tool tối đa 1 process `late` còn sống. Lời gọi khác trong lúc đó trả lỗi "still running".
- Tối đa **2** process `late` chạy cùng lúc, tính chung mọi plugin. Lời gọi thứ ba trả lỗi và không chạy.
- Dòng hai đi đúng đường của dòng đầu: kiểm tra phiên, lọc (12.4), `PostToolCall`, rồi luật 👂.
- T0 (2026-11-20): cả `gemini-3.8-live` và `gemini-3.1-flash-live-preview` nhận `NON_BLOCKING` + `willContinue` + `WHEN_IDLE`. Kết quả luôn vào context, nhưng Iris chỉ tự nói ra khoảng 50–67% số lần; còn lại phải hỏi thì Iris mới đọc.

### 12.4 Lọc output

Mọi chữ từ script (dòng đầu, dòng `late`, lỗi kèm stderr) đi qua lõi trước khi tới Gemini:
- bỏ mã ANSI và ký tự điều khiển (giữ xuống dòng và tab);
- bỏ dấu của lõi: `SYSTEM_EVENT_HOOK`, `[session]`, `<owner_notes>`, `</owner_notes>`;
- cắt ở 8000 ký tự;
- bọc thành dữ liệu có tên: `{ "output": { "plugin_output": "…", "from": "<plugin>" } }` (lỗi: `{ "error": { "plugin_output": "…", "from": "<plugin>" } }`). Lỗi do lõi tạo (quá giờ, chưa tin cậy, still running, `NEEDS_CONFIRMATION`) là chuỗi thường.

Bộ lọc là lớp thứ hai. Lớp chính vẫn là luật cho người viết plugin: không đọc màn hình terminal (mục 5). iris-security đánh giá chuỗi "output plugin → Gemini → tool desktop".

### 12.5 Luật an toàn trước khi chạy

- **Kiểm tra args** theo `parameters` trước khi spawn: đúng kiểu (`number` phải hữu hạn), đúng `enum`, đủ `required`, mỗi chuỗi tối đa 4000 ký tự. Khoá không khai báo bị bỏ. Sai thì trả lỗi và script không chạy. Args vẫn là dữ liệu không đáng tin (12.2).
- **Băm lại trước mỗi lần spawn**, không chỉ lúc bắt đầu phiên. Thư mục plugin bị sửa sau khi user tin cậy thì tool trả lỗi "not trusted" và không chạy, cho tới khi user tin cậy lại (hoặc thư mục trở về đúng bản đã tin cậy, vì mã băm khớp lại).
- **Cảnh báo tin cậy** (`trust.warning` trong danh sách plugin): lệnh và tool của plugin được tin cậy chạy với quyền của user, đọc được mọi file user đọc được, kể cả `~/.open-iris/.env` (khoá Gemini).

### 12.6 Cờ tainted

- Khi output của tool plugin tới Gemini (dòng đầu hay dòng `late`, output hay lỗi), lõi đánh dấu phiên là tainted.
- Chữ do hook `command` tạo ra cũng là dữ liệu plugin: context của `SessionStart`, `addContext` của `UserTurn`/`IrisTurn`/`ListenOnlyChanged`, context và lý do chặn của `PreToolCall`/`PostToolCall`, `speak` (kể cả `Tick`), và lỗi kèm stderr. Chữ này qua bộ lọc 12.4 và bật cờ tainted khi được gửi đi. Hook `command` ở `SessionStart` làm phiên tainted ngay từ đầu, và lại tainted sau ↺ (chữ đó vẫn nằm trong system instruction). Chữ tĩnh trong `hooks.json` (hook `context`, `speak`) không bật cờ.
- Context của `PostToolCall` cho dòng `late` cũng qua bộ lọc 12.4.
- Trong lúc tainted, `click_app_control`, `type_into_text_field`, `press_key_combo`, `pick_list_option`, `open_or_focus_app` và **mọi tool plugin** (`<plugin>__<tool>`, kể cả tool có `confirm`) trả `NEEDS_CONFIRMATION` và không chạy. `confirmed: true` một mình không đủ. Khi user nói hay gõ (cờ đã xoá), lời gọi lại sẽ chạy.
- Chỉ lời nói thật của user (input transcription) hay chữ gõ ở ô nhập mới xoá cờ. Output plugin, context/speak của hook và lời của Iris không xoá. ↺ và phiên mới cũng xoá (trừ trường hợp hook `command` ở `SessionStart` nói ở trên).
- Làm bằng hook `PreToolCall` của lõi (`createHooks` `core`, `createTaint()` trong `hooks.mjs`), chạy sau mọi hook plugin; plugin không bỏ qua được.
