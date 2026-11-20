# Plan: bỏ Orca CLI khỏi `main` để phát hành cho mọi người

**Trạng thái:** workflow đã chạy ngày 2026-11-20. Xong bước 1-3, 5, 7. Bước 4 (xem trước HTML) làm sau khi đã sửa. Còn lại cho user: bước 6 (chạy eval, cần API key) và bước 8 (build, thử trên máy sạch).

## Mục tiêu

`main` là bản public. Ai có máy Mac và Gemini key cũng chạy được, không cần Orca hay Claude Code.

Bản public giữ lại ba phần:
- **Gemini voice**: Gemini Live, persona, skills, livestream (đồng dẫn, tóm tắt, chỉ nghe).
- **Hand Task Vision**: điều khiển chuột bằng tay, HUD, Gallery View.
- **agent-desktop**: điều khiển ứng dụng qua accessibility.

Bỏ hẳn phần **giao việc lập trình** (Orca CLI + Claude Code): 7 tool `*_coding_task*`, chọn session, tab Advanced Tools.

Bản đầy đủ có Orca nằm ở nhánh `open-iris-mrq` (worktree `~/orca/workspaces/open-iris/open-iris-mrq`), tách từ `main` ở commit `fbc5997`. Plan này không đụng tới nhánh đó.

## Những chỗ phải sửa

| File | Việc |
|---|---|
| `src/main/tools.mjs` | Xoá cả file. Chỉ `main.mjs` import nó. |
| `src/main/tools.selftest.mjs` | Xoá. Bỏ khỏi script `test`. |
| `src/main/main.mjs` | Bỏ import từ `tools.mjs`. Bỏ `coding`, `session` trong `clean()` và `connectLive`. `enabledTools` chỉ còn `desktopTools()` + skill. Bỏ IPC `sessions:list`, `sessions:open`, `coding:check`, `config:coding`, `config:session`. Bỏ `sendFollowUp` / `willContinue` (xem câu hỏi 2). |
| `TOOL_DEFAULTS` / `cleanTools` | Chuyển sang `desktop.mjs`, chỉ còn 9 tool desktop. Config cũ có key `*_coding_*` tự bị bỏ vì `cleanTools` chỉ giữ key nó biết. |
| `src/main/live-config.mjs` | Bỏ mọi câu gắn với `start_coding_task`, `recall_past_coding_tasks`, `stop_coding_task`, `clear_coding_memory`. Câu "never mention agents, sessions, Claude Code" đổi thành không nhắc Claude Code. Giữ "Never use the app tools to read a terminal window." |
| `src/main/desktop.mjs` | Không đổi logic. Chỉ sửa comment dòng 118 (đang nhắc `tools.mjs registry()`). |
| `src/preload/preload.cjs` | Bỏ `checkCoding`, `saveCoding`, các hàm session. |
| `src/renderer/index.html` | Bỏ `#session-row`, khối Advanced Tools (`#coding`, `#coding-box`, `#coding-tools`, `#coding-why`). Sửa câu giới thiệu "talks to Claude Code through Orca". |
| `src/renderer/renderer.js` | Bỏ `showCoding`, `codingLocked`, `loadSessions`, nhóm tool `coding`, `session`/`coding` trong opts khi Start. |
| `src/renderer/welcome.js` | Bỏ dòng kiểm tra Orca CLI và Claude Code, bỏ năng lực "🤖 Giao việc cho Claude Code" và bước hướng dẫn của nó. |
| `src/renderer/style.css` | Bỏ rule chỉ dùng cho các phần tử vừa xoá. |
| `eval/tool-choice.mjs` | Bỏ 6 câu `expect: [*_coding_*]`. Thêm câu "đọc màn hình terminal" → không gọi tool nào. |
| `README.md` | Bỏ gạch đầu dòng Claude Code/Orca và câu về Orca ở phần privacy. Thêm phần livestream nếu chưa có. |
| `CLAUDE.md` | Câu đầu và `tools.mjs` trong Layout. Bỏ luật "never send a terminal screen, Orca screen". |
| `.claude/`, `.agents/` | Xem câu hỏi 3. |

`src/gesture/hud.mjs` dòng 116 có nhắc "Orca terminals" khi dò process cha để xin quyền. Đó là chuyện chạy app từ terminal nào, không phải tính năng Orca. Giữ nguyên.

## Các bước

1. Xoá `tools.mjs`, `tools.selftest.mjs`; chuyển `TOOL_DEFAULTS`/`cleanTools` sang `desktop.mjs`, thêm test `cleanTools` vào `desktop.selftest.mjs`.
   → `pnpm test` qua.
2. Sửa `main.mjs`, `preload.cjs`.
   → `pnpm test` qua; `grep -rniE "orca|coding|claude code" src` chỉ còn `hud.mjs`.
3. Sửa `live-config.mjs`, cập nhật `live-config.selftest.mjs`: system instruction không còn chữ `coding_task`.
   → `pnpm test` qua.
4. Làm bản xem trước HTML tạm cho tab Thiết lập và màn hình chào sau khi bỏ Advanced Tools (luật của repo: UI đổi thì xem trước). Chờ duyệt.
5. Sửa `index.html`, `renderer.js`, `welcome.js`, `style.css`.
   → `pnpm dev`: mở được, tab Thiết lập không còn Claude Code, Start rồi nói "mở Safari" vẫn chạy; log `connecting ... tools=` không có tool coding.
6. Chạy `node eval/tool-choice.mjs`.
   → mọi câu đúng tool.
7. Sửa README, CLAUDE.md. Chạy `gitleaks git .` và `gitleaks dir .`.
   → chỉ còn `.env` (đã gitignore).
8. `pnpm build`, mở app trong `out/` trên máy sạch hoặc user macOS mới (không có Orca, không có `~/.claude`).
   → màn hình chào không đòi Orca; voice, tay, agent-desktop chạy.
9. Commit từng bước một, push `main`.

## Câu hỏi cần chốt trước khi làm

1. **Hỏi về ảnh trong Gallery.** ✅ Chốt (2026-11-20): bỏ. Gallery View chỉ còn Hand Task Vision, Gemini Live voice và agent-desktop. Câu `[gallery]` vẫn báo cho Gemini ảnh đang xem, chỉ bỏ câu giao ảnh cho `start_coding_task` trong `live-config.mjs`.
2. **Cơ chế `followUp` / `willContinue`** (tool trả lời hai lần) hiện chỉ tool coding dùng. ✅ Chốt (2026-11-20): xoá. Khi làm plugin (`docs/plugin-plan.md`) cần thì thêm lại.
3. **Đồ nghề dev trong repo public.** `.claude/settings.json` bật plugin cá nhân (`ponytail`, `excalidraw-live`); `.claude/agents/*-diagram.md` là agent vẽ sơ đồ riêng; `.agents/skills` và `.claude/skills` là skill tải về (`skills-lock.json`).
   - (Đề xuất) Bỏ `.claude/settings.json` và `.claude/agents/` khỏi `main`, giữ ở `open-iris-mrq`. Giữ skill vì có lock file, ai cũng tải lại được.
   - Trạng thái (2026-11-20): vẫn chưa chốt, chưa xoá gì trong `.claude/` hay `.agents/`.
4. **Quan hệ hai nhánh.** ✅ Chốt (2026-11-20): `main` và `open-iris-mrq` phát triển độc lập, không merge qua lại. Sửa lỗi cần ở cả hai thì làm riêng ở từng nhánh (hoặc `git cherry-pick` nếu file còn giống nhau).

## Rủi ro

- Config cũ ở `~/.open-iris/config.json` còn `coding: true`, `session`. `clean()` bỏ key không biết nên không lỗi, chỉ cần kiểm tra ở bước 5.
- Câu lệnh system instruction đổi có thể làm Gemini chọn tool khác. Bước 6 bắt việc này.
- Hai nhánh độc lập nên một lỗi sửa ở nhánh này không tự sang nhánh kia.

## Ngoài phạm vi

- Ký và notarize app để phát hành bản build (`pnpm build` hiện chưa ký).
- Hệ thống plugin.
- Hỏi về nội dung ảnh trong Gallery (đã chốt bỏ ở câu hỏi 1).
