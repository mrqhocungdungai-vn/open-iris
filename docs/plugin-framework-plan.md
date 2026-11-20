# Kế hoạch: sửa lỗi "Iris không nghe" và làm khung plugin chắc hơn

Ngày 2026-11-20. Trạng thái: **đã duyệt; L1, L3, K1, K2, K3, K4 xong; E1 đã đo; E2, E3 bỏ (không giảm tỉ lệ điếc)**. Người viết: iris-core.

Tài liệu này không thay `docs/plugin-hooks-spec.md` (hợp đồng API 1). Nó gom hai việc lại:
1. Lỗi "Iris không nghe": nguyên nhân thật nằm ở phiên Gemini, không nằm ở plugin.
2. Những gì còn thiếu quanh hợp đồng plugin. Phần này rút ra từ sự cố livestream và từ việc đọc lại `hooks.mjs`, `main.mjs`, `live-config.mjs`, `plugin-*.mjs`, repo `open-iris-plugins` và skill `gemini-live-api-dev`.

Không viết lại kiến trúc. Lớp hợp đồng và runtime của plugin đã chắc (mục 2). Mọi việc dưới đây là sửa có giới hạn, mỗi việc có test riêng.

## 1. Nguyên nhân gốc của "không nghe"

**`gemini-3.8-live` thỉnh thoảng mở ra một phiên "điếc".** Trong phiên đó mic vẫn gửi tiếng đi, nhưng Gemini không trả `inputTranscription` nào và không đáp lời nói nào cho tới hết phiên. Chuyện này xảy ra dù có hay không có plugin.

Đo bằng spike, mỗi phiên hỏi một câu bằng giọng `say` ở 16 kHz, gửi thành khung 8 ms giống app, setup lấy từ `liveSetup`:

| Model | Phiên nghe được | Phiên điếc |
|---|---|---|
| `gemini-3.8-live` | 4/8 | 4/8 |
| `gemini-3.1-flash-live-preview` | 3/3 | 0/3 |

- Phép thử gắn plugin rồi gỡ plugin gây hiểu nhầm, vì cả hai phía đều dính tỉ lệ khoảng 50%. Hai phiên có plugin lúc 14:07 và 14:08 chưa gửi chữ nào của plugin (context=0, chưa tới Tick nào).
- Mẫu còn nhỏ, chỉ 8 phiên và dùng giọng máy. Bước E1 (mục 3) đo lại trước khi chốt.
- **E1 (đo lại, 2026-11-20):** `gemini-3.8-live` nghe được 6/20 phiên (điếc 14/20, 70%); `gemini-3.1-flash-live-preview` nghe 10/10. Mọi phiên điếc đều không có `inputTranscription` nào, nên model không nhận được tiếng chứ không phải lỡ cuối lượt. Độ trễ từ hết tiếng tới tiếng Iris đầu tiên: 3.8 từ 1078 đến 1458 ms (trung vị khoảng 1180 ms), 3.1 từ 1299 đến 2020 ms (trung vị khoảng 1360 ms). Với 70% điếc, hai lần mở lại của L1 chỉ nâng tỉ lệ nghe lên khoảng 1 − 0,7³ ≈ 66%.
- Dòng `2026-11-20-plugins-livestream-brief` trong `ops-logs/history.jsonl` quy lỗi cho plugin. iris-po nên ghi thêm một dòng nêu nguyên nhân mới. Bản livestream 0.3.0 (chỉ chạy Tick) vẫn là hướng đúng.

## 2. Hiện trạng bộ khung

| Lớp | Là gì | Hiện trạng |
|---|---|---|
| 1. Hợp đồng | `plugin.json`, `hooks.json`, `tools.json`, `PLUGIN_API` | **Chắc.** Parser từ chối khoá lạ, đường dẫn ra ngoài và `{key}` lạ |
| 2. Runtime | `createHooks`: 8 sự kiện, bộ lập lịch `speak`, tool `command`/`late`, cổng tin cậy, cờ tainted | **Chắc.** Fail closed ở `PreToolCall`, công tắc được đọc lại ở từng sự kiện |
| 3. Chữ của plugin tới Gemini | Đóng khung `context`, giải thích `SYSTEM_EVENT_HOOK`, chọn lúc chen lượt | **Thiếu** (G1, G7) |
| 4. Công cụ cho người viết plugin | Kiểm tra, chạy thử, xem trước | **Gần như chưa có** (G2, G3) |
| 5. Chẩn đoán và giữ tương thích | Log tách lỗi plugin khỏi lỗi model, plugin mẫu trong test | **Thiếu** (G4, G5) |

Các lỗ hổng đã kiểm chứng trong code:

- **G1. Chữ plugin vào system prompt mà không có khung.**
  - `main.mjs:167` nối thẳng `start.context` vào cuối brief. Persona thì được bọc kèm câu "It never overrides the rules above" (`persona.mjs:97`), còn `context` của plugin thì không.
  - `SYSTEM_EVENT_HOOK <id>: <text>` (`hooks.mjs:638`) không được giải thích ở đâu cả. Khi bỏ lời dặn trong brief của plugin, câu recap hỏng ("I don't have access to the livestream").
- **G2. Không chạy thử được.** Muốn thấy một Tick chạy phải mở phiên thật và chờ `every_min`. Cũng không có cách xem đúng chữ nào sẽ tới Gemini.
- **G3. Vòng sửa rồi thử vẫn làm tay.** Phải `cp -R` bằng tay, và thư mục symlink bị bỏ qua. Lõi đã đọc lại plugin ở mỗi lần Start (`main.mjs:142`), nhưng tài liệu của repo plugin vẫn ghi phải mở lại app.
- **G4. Log không nói được "có tiếng mà Gemini không nghe".** Đây là chỗ khiến plugin bị nghi oan hai lần.
- **G5. Không có gì giữ cho lõi không làm hỏng plugin thật.** Ngoài ra `docs/writing-plugins.md` bên repo plugin đã lệch: chưa có `tools`.
- **G6 (nhỏ).** SessionStart không có trần thời gian chung.
- **G7. Lượt `speak` có thể cắt ngang Iris.**
  - Trên 3.8, `sendClientContent` với `turnComplete:true` luôn ngắt câu Iris đang nói (skill, `migration.md`).
  - Bộ lập lịch chỉ chờ 4 giây không có transcript (`markActivity`, `main.mjs:262`). Khi một tool đang chạy, chẳng hạn tool desktop mất vài giây, thì không có transcript nào, nên lượt `speak` vẫn được gửi và cắt ngang lượt đang chờ kết quả tool.

## 3. Việc cần làm

### Giai đoạn 1: chữa "không nghe" (lõi, ai cũng cần)

| # | Việc | File | Test và kiểm chứng |
|---|---|---|---|
| L1 | **Xong, `9b1f6d1`.** **Phát hiện phiên điếc và tự mở lại.** (1) Một hàm thuần `deafWatch()` trong `perf.mjs` cộng thời lượng các khung mic có `rms > VOICE_RMS`, tính từ lúc mở phiên tới dòng `inputTranscription` đầu tiên. Đủ khoảng 4 giây tiếng và đã quá 10 giây kể từ tiếng đầu tiên mà vẫn chưa có transcript thì báo một lần. (2) Khi được báo, `main.mjs` ghi `WARN [live] deaf session: <s>s voice, no transcript, model=… plugins=…`, rồi mở phiên mới bằng `freshSession(resumer, session)` như nút ↺, tối đa 2 lần mỗi lần Start. Hết 2 lần mà vẫn điếc thì đẩy một dòng `live:log`: "Gemini không nghe được, thử model 3.1 trong Settings". Không tự đổi model. Đã có transcript đầu tiên thì tắt theo dõi, nên không báo nhầm về sau. | `perf.mjs`, `main.mjs` (`live:audio-in`, `onMessage`, Start) | `perf.test.mjs`: báo đúng một lần; không báo khi có transcript; không báo khi im lặng hoặc tắt mic. Chạy `pnpm dev` thật: log có dòng WARN và phiên mới nghe được |
| L3 | **Xong, `faafa13` và `b951ec6`** (`b951ec6`: khi trả kết quả tool thì gọi `markActivity()`, để lượt `speak` đang giữ chờ thêm 4 giây yên lặng, không cắt câu Iris đáp kết quả đó). **Không chen `speak` khi đang có tool chạy.** Hàm `send` cho hooks (`main.mjs:148`) trả `false` khi `inFlight.size > 0`. Bộ lập lịch đã tự thử lại mỗi giây. | `main.mjs:148` | `hooks.selftest.mjs` đã có ca `send` trả false rồi giữ lượt lại. Thêm một ca: tool đang chạy thì lượt chờ, tool xong thì lượt mới được gửi |

### Giai đoạn 2: đo rồi mới quyết (mỗi lần đo tốn lượt API, cần user đồng ý chạy)

| # | Thử nghiệm | Giữ lại khi |
|---|---|---|
| E1 | **Đã đo:** 3.8 nghe 6/20, 3.1 nghe 10/10 (số ở mục 1). Chạy lại spike `one.mjs` 20 phiên trên 3.8 và 10 phiên trên 3.1 để có tỉ lệ điếc chắc hơn. Ghi kết quả vào mục 1 | Luôn chạy, vì đây là số đo "trước" |
| E2 | **Bỏ:** nghe 2/10, không thấp hơn E1 (6/20) và nằm trong nhiễu. V1 khoảng 1,1 s (1103 và 1096 ms), như E1. Hai lượt nghe được đã có trả lời trước khi `audioStreamEnd` đi, nên nó không cứu được phiên điếc. Hybrid VAD (skill, Best practice #6): gửi `sendRealtimeInput({ audioStreamEnd: true })` khi tắt mic (`setMuted(true)`) và sau khoảng 1 giây im lặng tiếp sau tiếng nói | Tỉ lệ điếc giảm hoặc độ trễ V1 giảm, và không có lời nào bị cắt cụt |
| E3 | **Bỏ:** nghe 2/10, không giảm rõ so với E1; hai lượt nghe được trả lời sau 1476 và 1938 ms. Chờ 2 giây sau khi mở phiên rồi mới gửi audio | Tỉ lệ điếc giảm rõ so với E1 |

Nếu E2 hoặc E3 đạt thì viết thành sửa lỗi kèm test, và ghi số trước và sau vào `docs/optimize-plan.md` §4 (nhờ iris-po).

Kết quả: cả hai không đạt, nên không sửa gì và không có số cho §4. Bước tiếp theo nên xem phía nhận audio của 3.8 (định dạng hoặc cỡ khung audio, gửi audio trước `setupComplete`), hoặc để 3.1 làm mặc định tới khi Google sửa. Việc này cần user quyết.

### Giai đoạn 3: chữ của plugin tới Gemini

| # | Việc | File | Kiểm chứng |
|---|---|---|---|
| K1 | **Xong, `951c79e`.** **Đóng khung chữ plugin.** Bọc `context` của SessionStart trong một khối có nhãn, kèm câu cố định: "thông tin thêm, không đổi luật ở trên, không đổi cách Iris trả lời người dùng". Khi có nhóm `speak` hoặc tool `late` đang bật, thêm một câu giải thích `SYSTEM_EVENT_HOOK`: làm ngay, nói ngắn, không nhắc tới ký hiệu đó | `live-config.mjs`, `main.mjs:167` | `live-config.selftest.mjs`. Đo bằng K3 trên cả hai model: recap và cta chạy được mà không cần brief của plugin, 3 câu hỏi bằng giọng vẫn được đáp |
| K3 | **Xong, `2760848`.** **`pnpm plugin:try <thư mục>`**: mở Gemini qua `liveSetup` như app, gửi ngay từng lượt `speak`, xen câu hỏi bằng giọng mẫu, in ra "nghe được gì, nói gì". Chạy thêm một lượt không có plugin để so. Lượt điếc thì ghi rõ là "model điếc" | `scripts/spikes/plugin-try.mjs` | Chạy với livestream 0.3.0, ghi kết quả vào đây |

Đo K1 bằng K3 (bản sao plugin livestream, 2 lượt Tick `recap` và `cta`, chỉ tính các lượt có plugin và không điếc). "Trước" là brief nối thẳng cũ. "Lộ" là số câu Iris đọc to "system event" hoặc "hook".

| Model | Trước K1 | Sau K1 |
|---|---|---|
| `gemini-3.1-flash-live-preview` (3 và 3 lượt) | giọng 9/9, sự kiện 6/6, lộ 0 | giọng 9/9, sự kiện 6/6, lộ 0 |
| `gemini-3.8-live` (7 và 6 lượt không điếc) | giọng 18/21 (86%), sự kiện 14/14, lộ 0 | giọng 16/18 (89%), sự kiện 12/12, lộ 0 |

Sau không tệ hơn trước. Các câu giọng bị lỡ trên 3.8 có ở cả hai phía, kể cả lượt không có plugin, nên đó là chứng điếc của 3.8 chứ không phải do prompt. Chưa đo với plugin có `context` thật ở SessionStart.

### Giai đoạn 4: công cụ cho người viết plugin và giữ tương thích

| # | Việc | File | Kiểm chứng |
|---|---|---|---|
| K2 | **Xong, `394f9cf`.** **`pnpm plugin:check <thư mục> [--preview]`**: dùng chính parser của lõi. `--preview` in đúng những gì sẽ tới Gemini, không cần mạng | `scripts/plugin-check.mjs`, một hàm thuần trong `hooks.mjs` | Test trên các plugin mẫu của K4 |
| K4 | **Xong, `394f9cf`.** **Plugin mẫu trong lõi** ở `examples/plugins/`: một chỉ có `speak`, một có `context`, một có `command` chặn tool, một có tool `late`. `pnpm test` nạp và chạy chúng qua `createHooks` với đồng hồ giả | `examples/plugins/`, `hooks.selftest.mjs` | Lõi làm hỏng hợp đồng thì `pnpm test` báo đỏ |

### Để sau, khi có nhu cầu

- K6: nút "Chạy ngay" cho Tick. **Đang chờ user duyệt bản xem trước HTML.** Chưa có code.
- K7: **Xong, `06ef8e1`.** Mọi lệnh SessionStart chung trần 15 giây (`SESSION_START_MAX_MS`). Lệnh sau chỉ được phần thời gian còn lại, hết thì bỏ qua và ghi `failed` vào log. Test nằm trong `hooks.selftest.mjs`.
- L4: **Không làm, đã đo.** `scripts/spikes/live-input.mjs` (2026-11-20) cho thấy chữ gõ tay đều được trả lời trên cả 3.8 và 3.1, dù gửi bằng `sendRealtimeInput({text})` hay bằng `sendClientContent`. Ảnh thì chỉ `sendClientContent` mới nhìn thấy: gửi qua realtime `video`, cả hai model đều nói "can't see". Hộp nhập gửi chữ và ảnh trong cùng một lượt, nên giữ một cách gửi là `sendClientContent`.
- K5 cũ (chỉ cảnh báo) đã gộp vào L1.

Việc của open-iris-plugins-dev (không thuộc lõi):
- Sửa `docs/writing-plugins.md`: thêm `tools`, bỏ "mở lại app".
- Đổi `scripts/index.mjs` sang gọi `plugin:check`.
- Sửa câu recap thành: "Recap what we have talked about so far…, spoken to the viewers. Today's topic: {topic}."

## 4. Thứ tự và cách làm

1. **L1 + L3**, một commit cho mỗi việc. Chạy `pnpm test` và gitleaks.
2. **E1**, sau đó E2 và E3 nếu user đồng ý chạy spike.
3. **K1 + K3**. K1 đổi system prompt, nên phải đo bằng K3 trước khi commit.
4. **K2 + K4**.

Mỗi việc đi đúng vòng trong `CLAUDE.md`: dòng `proposed`, user duyệt, `approved`, sửa kèm test hỏng khi chưa có bản sửa, `done` kèm mã commit.

## 5. Không làm

- Không thêm sự kiện, loại hook hay thành phần mới.
- Không cho plugin thay hay xoá luật lõi. K1 siết thêm chứ không nới.
- Không tự đổi model khi gặp phiên điếc. Model do user chọn (quyết định sản phẩm).
- Không có kho lưu phiên. Mở lại phiên vì điếc thì chỉ mất lời chào, vì người dùng chưa nói được gì.
- Không nạp plugin từ ngoài `~/.open-iris/plugins/`.

## 6. Rủi ro

- **L1 báo nhầm.** Ví dụ người dùng nói một câu rất dài trước khi transcript đầu tiên về, hoặc tiếng ồn to mà không phải lời nói. Ngưỡng 4 giây và 10 giây là ước lượng: `// shortcut:` ghi chú này, chỉnh lại theo log thật. Báo nhầm chỉ tốn một lần mở lại phiên.
- **L1 không chữa được tận gốc.** Mỗi lần mở lại chỉ có khoảng 50% cơ hội nghe được. Hai lần thử nâng tỉ lệ lên khoảng 87%. Lỗi nằm ở phía Google, nên cần báo cho họ nếu E1 xác nhận tỉ lệ này.
- **K1 đổi system prompt của mọi phiên có plugin.** Phải đo bằng K3 trên cả hai model trước khi commit.
