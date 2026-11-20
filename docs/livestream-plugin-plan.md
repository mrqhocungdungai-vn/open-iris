# Kế hoạch: plugin Livestream (tóm tắt + call to action, Chủ đề + Mục tiêu)

Ngày 2026-11-20. Trạng thái: đã chốt mục 6 (2026-11-20), đang làm L1.

Yêu cầu: "phát triển tính năng plugin livestream với background task call tổng hợp và call to action, và mục topic và mục tiêu của buổi livestream".

## 1. Hiện trạng

- Livestream đã bỏ khỏi lõi (R1, commit `b80d082`). Code cũ ở `1c97738`: `cohostBrief`, `createRecap` (đếm giờ + chờ im lặng 4 s + giữ lượt khi bị chặn), `RECAP_EVENT`. Phần này tái dùng được gần như nguyên.
- 👂 Chỉ nghe nằm ở `src/main/listen.mjs`, `main.mjs` giữ biến `listenOnly`.
- **Chưa có bộ nạp plugin**: P1 (`plugins.mjs`) trong `plugin-pack-plan.md` chưa làm. Plugin Livestream cần ít nhất một phần P1.
- **Phiên Gemini tự đóng sau ~10 phút, không tự nối lại** (`// shortcut:` trong `main.mjs`, onclose). Với tóm tắt 5 phút, một phiên chỉ được 1 lần. Livestream dài 1–2 giờ thì phải có nối lại phiên (session resumption) trước, nếu không plugin gần như vô dụng.

## 2. Đề xuất: lõi có `tasks.json` + ô nhập, plugin vẫn chỉ là dữ liệu

Giữ quyết định "plugin không chứa code". Lõi thêm hai loại dữ liệu mới; bộ hẹn giờ là code lõi, plugin chỉ khai báo.

```
livestream/
  .open-iris-plugin/plugin.json   # tên, mô tả, fields, brief
  tasks.json                      # các task nền
```

### 2.1 `plugin.json`: ô nhập và brief

```json
{
  "name": "livestream",
  "version": "0.1.0",
  "description": "Iris làm đồng dẫn livestream: tóm tắt định kỳ và kêu gọi hành động.",
  "fields": [
    { "key": "topic", "label": "Chủ đề", "label_en": "Topic", "max": 200 },
    { "key": "goal",  "label": "Mục tiêu", "label_en": "Goal", "max": 300,
      "hint": "Ví dụ: tăng follow, bán khoá học X, chốt 20 đơn" }
  ],
  "brief": "Livestream mode: you are the voice co-host ... Today's topic: {topic}. Goal of this livestream: {goal}. ..."
}
```

- `fields`: ô một dòng người dùng tự nhập ở tab Plugin. Lưu ở `~/.open-iris/config.json` → `plugins.livestream.fields`. Không ghi vào repo.
- `brief`: nối vào system instruction lúc Start khi plugin bật. `{key}` thay bằng giá trị ô nhập (ô trống → bỏ cả câu chứa nó). Tối đa 1000 ký tự.
- Sửa Chủ đề/Mục tiêu giữa buổi: brief áp dụng từ lần Start sau, nhưng prompt của task điền giá trị **lúc chạy**, nên tóm tắt/CTA kế tiếp đã dùng giá trị mới.

### 2.2 `tasks.json`: task nền theo chu kỳ

```json
[
  { "name": "recap", "label": "Tóm tắt định kỳ", "label_en": "Periodic recap",
    "every_min": 5,
    "prompt": "Recap now, 2-3 short sentences: what was discussed in the last few minutes, then restate today's topic ({topic}) for viewers who just joined. Do not mention that this is scheduled." },
  { "name": "cta", "label": "Kêu gọi hành động", "label_en": "Call to action",
    "every_min": 7,
    "prompt": "Give one call to action now, 1-2 short sentences, serving this goal: {goal}. Tie it to what was just said. Vary the ask and the wording; never repeat a previous one." }
]
```

Luật lõi (cố định, plugin không đổi được):
- Chỉ chạy khi phiên Gemini đang mở và **không** ở 👂 Chỉ nghe. Đang 👂 thì giữ lượt, tắt 👂 xong mới nói (giống `createRecap` cũ trả `false`).
- Đến giờ mà có người đang nói (người dùng hoặc Iris) thì chờ tới khi im lặng 4 s, không bỏ lượt.
- Hai task cách nhau ít nhất 60 s, để CTA không dính sát tóm tắt.
- Gửi qua `sendClientContent(..., turnComplete: true)` với tiền tố `SYSTEM_EVENT_TASK <plugin>/<name>:`.
- `every_min` từ 2 đến 60. Người dùng chỉnh được chu kỳ từng task ở tab Plugin. Mỗi task có công tắc riêng, cài xong mặc định tắt.
- `// shortcut: chỉ có kích theo giờ; kích theo ngữ cảnh (vd. khán giả hỏi giá → CTA mua hàng) để sau, khi có transcript khán giả.`

"Theo ngữ cảnh" ở v1 nghĩa là prompt bắt Gemini bám vào điều vừa nói + Mục tiêu, không phải bộ kích riêng.

### 2.3 Plugin ở đâu

- Nguồn: repo `open-iris-plugins/livestream/` (đang trống).
- Cài: chép thư mục vào `~/.open-iris/plugins/livestream/` (nút "Mở thư mục plugin"). Ô dán URL GitHub để P5.

## 3. Phương án khác (không chọn)

| Phương án | Vì sao không |
|---|---|
| Đưa Livestream lại vào lõi (revert R1) | Ngược quyết định 2026-11-20. |
| Plugin có code (hook JS chạy trong main) | Phá nguyên tắc "không chạy code lạ"; cần sandbox. Để chung với MCP (P3 `plugin-plan.md`). |
| Gộp CTA vào tóm tắt như bản cũ | Ít linh hoạt: không tắt riêng, không chỉnh chu kỳ riêng. Vẫn làm được bằng một task duy nhất nếu muốn. |

## 4. Các bước

Mỗi bước kết thúc bằng `pnpm test` qua.

| # | Việc | Kiểm chứng |
|---|---|---|
| L0 | **Nối lại phiên** (session resumption của Gemini Live) khi bị đóng ~10 phút, giữ `listenOnly` và bộ hẹn giờ. | `pnpm dev`: để phiên chạy 25 phút, log có `resumed`, nói tiếp vẫn trả lời. |
| L1 | `src/main/tasks.mjs`: đọc/kiểm `plugin.json` (fields, brief) và `tasks.json`; điền `{key}`; `createScheduler` (tổng quát từ `createRecap`, nhiều task, khoảng cách 60 s). Đây là lát đầu của P1, P1 sau mở rộng tiếp. | `tasks.selftest.mjs`: JSON sai, `every_min` ngoài khoảng, key lạ trong prompt bị từ chối kèm lý do; đồng hồ giả: đến giờ + im lặng mới gửi; đang 👂 thì giữ, tắt 👂 thì gửi; hai task không gửi cách nhau < 60 s. |
| L2 | `main.mjs`: nạp plugin bật từ `~/.open-iris/plugins/`, nối brief lúc Start, chạy/dừng scheduler theo phiên, `markActivity` từ transcript. IPC `plugins:list` / `plugins:save`, preload `savePlugin`. | Selftest phần thuần; `pnpm dev` với chu kỳ 2 phút: log `task sent livestream/recap`. |
| L3 | Tab "Plugin" bản tối thiểu: thẻ plugin, công tắc gói, ô Chủ đề/Mục tiêu, công tắc + chu kỳ mỗi task. **Xem trước HTML tạm trước.** | Duyệt bản xem trước; sửa Chủ đề → CTA kế tiếp dùng giá trị mới. |
| L4 | Dữ liệu plugin trong `open-iris-plugins/livestream/` + README cài đặt. | Chép vào `~/.open-iris/plugins/`, bật, chạy một buổi thử 20 phút. |

## 5. Rủi ro

- Iris tự nói chen khi chủ live đang nói dở mà im > 4 s. Đã có: chờ im lặng, và 👂 chặn hẳn.
- CTA lặp, nghe như máy. Prompt yêu cầu đổi cách nói; Gemini nhớ trong phiên, nhưng nối lại phiên (L0) có thể làm mất trí nhớ đó.
- `brief`/`prompt` là prompt do plugin viết; giới hạn độ dài, và cổng xác nhận của lõi vẫn chặn thao tác rủi ro.

## 6. Đã chốt (2026-11-20)

1. Hướng mục 2: lõi có `tasks.json` + `fields`, plugin chỉ là dữ liệu. Người dùng mô tả: bật plugin thì Iris tổng hợp ngữ cảnh buổi Gemini Live, tóm tắt và nói ra loa, kèm kêu gọi follow, sub.
2. L0 nối lại phiên: **tách việc riêng**. Plugin làm trước, chỉ thử được trong phiên ngắn cho tới khi có L0.
3. CTA là **task riêng** (5 phút tóm tắt, 7 phút CTA, cách nhau ≥ 60 s).
4. Đang 👂: **giữ lượt**, tắt 👂 thì nói.
