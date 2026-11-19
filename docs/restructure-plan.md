# Plan: gom source code vào `src/`

## Mục tiêu

Thư mục gốc hiện có 14 file code nằm lẫn với file cấu hình. Người mở repo trên GitHub không biết bắt đầu đọc từ đâu.

Sau khi làm xong:
- Thư mục gốc chỉ còn cấu hình và tài liệu.
- Code nằm trong `src/`, chia theo process của Electron:
  - `main`: chạy Node, có toàn quyền với máy.
  - `preload`: cầu nối.
  - `renderer`: giao diện web, không được dùng Node.
- Chỉ di chuyển file và sửa đường dẫn. Không sửa logic, không thêm bundler hay TypeScript.

## Cấu trúc mới

```
src/
  main/       main.mjs, desktop.mjs, tools.mjs, persona.mjs, live-config.mjs
              desktop.selftest.mjs, tools.selftest.mjs, persona.selftest.mjs
  preload/    preload.cjs
  renderer/   index.html, renderer.js, welcome.js, style.css, mic-downsample.js
  gesture/    giữ nguyên cả thư mục: hud.mjs chạy ở main, phần còn lại ở renderer
assets/       icon app và icon menu bar (giữ ở gốc, dùng lúc build)
docs/  eval/
DESIGN.md     giữ ở gốc, vì skill hallmark tìm DESIGN.md ở thư mục gốc
README.md     mới
package.json  pnpm-lock.yaml  pnpm-workspace.yaml  skills-lock.json  .env.example  .gitignore
models/  out/ (bị gitignore, sinh ra bằng `pnpm fetch-model` và `pnpm build`)
```

`gesture/` giữ thành một thư mục theo tính năng, không chia theo process. Thư mục này nhỏ, đi cùng nhau, và các worktree khác đang sửa nó.

## Đường dẫn phải sửa

Đã kiểm tra bằng grep ngày 2026-11-19. Chạy lại grep trước khi làm.

| File (vị trí mới) | Chỗ cần sửa | Thành |
|---|---|---|
| `package.json` | `"main": "main.mjs"` | `"src/main/main.mjs"` |
| `package.json` | script `test` | `src/gesture/*.test.mjs src/main/*.selftest.mjs` |
| `src/main/main.mjs:21` | `repoEnv` = `dirname/.env` | `../../.env` (`.env` vẫn ở gốc) |
| `src/main/main.mjs:347` | icon Dock `assets/icon.png` | `../../assets/icon.png` |
| `src/main/main.mjs:357` | preload `preload.cjs` | `../preload/preload.cjs` |
| `src/main/main.mjs:361` | `loadFile("index.html")`, tính từ gốc app | `"src/renderer/index.html"` |
| `src/main/main.mjs:13` | `./gesture/hud.mjs` | `../gesture/hud.mjs` |
| `src/main/desktop.mjs:8` | `node_modules/agent-desktop/...` | `../../node_modules/agent-desktop/...` |
| `src/gesture/hud.mjs:193` | `../assets/trayTemplate.png` | `../../assets/trayTemplate.png` |
| `src/gesture/hud.mjs:223` | `../preload.cjs` | `../preload/preload.cjs` |
| `src/gesture/engine.js:4,70` | `../node_modules/@mediapipe/...` | `../../node_modules/...` |
| `src/gesture/engine.js:8` | `../models/hand_landmarker.task` | `../../models/...` |
| `src/gesture/hud-view.js:3` | `../node_modules/@mediapipe/...` | `../../node_modules/...` |
| `src/renderer/index.html:53,56,75` | link `gesture/*-guide.html` | `../gesture/...` |
| `src/renderer/index.html:115,116` | `gesture/setup.js`, `gesture/engine.js` | `../gesture/...` |
| `eval/tool-choice.mjs:9-11` | `../desktop.mjs` v.v. | `../src/main/...` |
| `.gitignore` | `gesture/.build` | `src/gesture/.build` |

Không phải sửa:
- Các import cùng thư mục (`./desktop.mjs`, `./hand.js`).
- `hud.mjs` đọc `gesture/index.html` và `mouse.swift` theo `dir`, mà hai file này đi cùng thư mục.
- `mic-downsample.js` nằm cùng thư mục với `index.html`.

Cần xem lại lúc làm:
- `.claude/settings.json` và docs có nhắc đường dẫn cũ không.
- `docs/plugin-plan.md` chỉ ghi tên file nên giữ nguyên.

## Các bước

1. **Chuẩn bị**
   - Commit phần build đang dở (`pnpm build`, `assets/icon.icns`, `out/`).
   - Chạy `pnpm test` (19/19) và `pnpm build` để lấy mốc so sánh.
   - Kiểm tra: `git status` không còn file của mình chưa commit.
2. **Chọn thời điểm**
   - Làm khi không session hoặc worktree nào đang sửa dở các file sẽ bị chuyển.
   - Các worktree hiện có: `research-hand-task-vison`, `test-agentdesktop-with-iris`, và repo gốc (`feat/open-iris-settings`) đang sửa `gesture/`.
   - Nên merge nhánh này vào `main` trước, rồi làm trên một nhánh mới tách từ `main`.
3. **Di chuyển** bằng `git mv` cho mọi file, để `git log --follow` vẫn theo được lịch sử.
   - Kiểm tra: `git status` chỉ còn các dòng `renamed:`.
4. **Sửa đường dẫn** theo bảng trên.
   - Kiểm tra: grep lại các tên file cũ, không còn đường dẫn nào trỏ sai.
5. **Thử app thật**
   - Chạy `pnpm test`, phải được 19/19.
   - Chạy `pnpm dev` và xem các thứ sau:
     - cửa sổ chính mở, có màu và CSS;
     - voice Start chạy;
     - camera và cử chỉ tay chạy (model được nạp);
     - các link hướng dẫn mở được;
     - bật HUD, có icon trên menu bar, thoát HUD được;
     - Gallery mở được;
     - một tool desktop chạy được (`agent-desktop`).
   - Chạy `pnpm build` rồi mở `out/.../open-iris.app`, kiểm tra cùng các mục trên.
   - Chạy `node eval/tool-choice.mjs --case 1`.
6. **Commit riêng**, chỉ gồm di chuyển file và sửa đường dẫn, không trộn thay đổi khác.
   - Như vậy merge các nhánh khác sẽ dễ hơn, vì git nhận ra file bị đổi tên.
7. **Sau đó, trong commit khác**
   - Viết `README.md` gồm: Iris là gì, cách cài (`pnpm i`, `pnpm fetch-model`, `.env`), `pnpm dev`, `pnpm build`, và bảng thư mục.
   - Thêm `LICENSE`.
   - Rà `.claude/` trước khi đưa repo lên mạng.

## Rủi ro

- **Merge với các nhánh khác.** Git nhận ra file đổi tên khi nội dung gần giống nhau. Nhưng nếu nhánh kia sửa đúng các dòng đường dẫn thì vẫn sẽ xung đột. Cách giảm rủi ro: làm nhanh trong một commit, và báo cho các session khác rebase.
- **Đường dẫn tương đối trong renderer** (`../../node_modules`) chỉ chạy được vì app không đóng gói vào asar (`--no-asar`). Nếu sau này bật asar thì phải xem lại.
- **Không có bundler**, nên renderer vẫn import thẳng từ `node_modules`. Như vậy là đủ cho app chạy trên một máy. Khi cần app nhỏ hơn hoặc ký app để phát hành thì mới tính tới electron-vite.

## Ngoài phạm vi

TypeScript, bundler, asar, ký và notarize app, giảm dung lượng bản build.
