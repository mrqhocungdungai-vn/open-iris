# Kế hoạch: giữ phiên Gemini Live dài (L0) và quản lý context

Ngày 2026-11-20. Trạng thái: **chờ user duyệt**, chưa sửa code theo bản này.

Bản này là việc L0 nhắc ở `docs/plugin-pack-plan.md` mục 5 và `docs/livestream-plugin-plan.md`. Nó dựa trên tài liệu Gemini Live và code đang chạy ở myiris (`electron/live-session.mjs`, `live-messages.mjs`, `live-config.mjs`).

## 1. Hiện trạng

- `connectLive` (`src/main/main.mjs`) mở **một** kết nối. Khi `onclose` chạy thì lõi gọi `endHooks()` (tức `SessionEnd`, dừng `Tick`), `setListenOnly(false)`, rồi báo `offline`. Người dùng phải bấm Start lại, và hội thoại mất.
- `goAway` chỉ được ghi log. Không có `sessionResumption` và không có `contextWindowCompression`.
- Có sẵn comment `// shortcut: no reconnect/session resumption ... port scheduleReconnect from myiris`.

## 2. Gemini Live cho gì (đọc ngày 2026-11-20)

| Tính năng | Tài liệu nói gì | Áp dụng cho open-iris |
|---|---|---|
| Giới hạn phiên | "Without compression, audio-only sessions are limited to 15 minutes" ([session-management](https://aistudio.google.com/docs/live-api/session-management)) | Chỉ có resume thì vẫn chết ở phút 15. **Cần cả nén context** |
| Giới hạn kết nối | "The lifetime of a connection is limited as well, to around 10 minutes" (cùng trang) | Đây là lần đóng ~10 phút ta đang gặp. Resume sửa được |
| `sessionResumption` | Bật bằng `sessionResumption: {}`. Server gửi `sessionResumptionUpdate { newHandle, resumable }`. Kết nối sau gửi `{ handle }`. "Resumption tokens are valid for 2 hr after the last sessions termination" | Giữ handle trong bộ nhớ, nối lại bằng handle mới nhất |
| `resumable: false` | "Resumption is not possible at some points in the session. For example, when the model is executing function calls or generating ... newHandle will be empty" ([API reference](https://aistudio.google.com/api-reference/live)) | Handle luôn là trạng thái **trước** lượt đang dở. Đứt giữa câu thì mất câu đó |
| `goAway` | Có `timeLeft` (Duration). Hết giờ thì kết nối bị đóng với ABORTED | Tín hiệu để nối lại sớm, lúc đang im |
| `contextWindowCompression` | `slidingWindow`. `triggerTokens` mặc định là 80% context của model, `targetTokens` mặc định là `triggerTokens/2`. "System instructions and any prefixTurns will always remain", phần cắt đi luôn ở đầu, bắt đầu lại ở một lượt USER | Bật với giá trị mặc định. System instruction không bao giờ bị cắt |
| Context của model | `gemini-3.8-live` và `gemini-3.1-flash-live-preview`: input 131.072 token ([trang model](https://aistudio.google.com/docs/models/gemini-3.8-live)) | Trigger mặc định ≈ 104.857, target ≈ 52.428. Đây cũng chính là con số myiris ghi cứng |
| Âm thanh | "Audio: 32 tokens per second" ([tokens](https://aistudio.google.com/docs/tokens)), trang chung, Live không nhắc lại | Một giờ nói liên tục ≈ 115k token |

**Tài liệu không nói:** đổi system instruction hay tool khi resume có được không; tool call đang dở có sống qua resume không; lỗi trả về khi handle hết hạn trông ra sao. Ba điểm này cần spike (bước S0).

**Kết quả S0** (`scripts/spikes/live-resume.mjs`, `gemini-3.8-live`, @google/genai 2.10.0, chạy 2026-11-20):

| Câu hỏi | Kết quả |
|---|---|
| Resume với system instruction và tool khác | Server **nhận**, không báo lỗi, nhưng **lặng lẽ giữ setup cũ**: model vẫn dùng secret word cũ và chỉ thấy tool cũ. Lịch sử còn nguyên. Vậy muốn đổi setup thì phải mở phiên mới; gửi lại y hệt (quyết định 3) là đúng |
| Handle sai | Kết nối mở rồi đóng `1008 "BidiGenerateContent session not found"`. Handle hết hạn (2 giờ) không thử được, coi như cùng đường. `resume.mjs` bỏ handle ngay khi gặp mã này |
| Sai key | Đóng `1007 "API key not valid. Please pass a valid API key."`. Không thử lại |
| Hết quota | Không tạo được trong spike. `resume.mjs` nhận theo chữ "exhausted"/"quota" trong lý do đóng, chưa kiểm chứng |
| Tool call đang dở lúc đóng | Trong lúc có tool call không có handle `resumable` mới. Sau resume, model **không gọi lại** tool và nói như thể vẫn đang chờ kết quả. Sau khi nối lại phải gửi lượt trạng thái báo tool đó đã huỷ (mục 6) |
| Kết nối im lặng | Không gửi audio thì sau **2 phút** server đóng `1008 "Session closed due to client inactivity."`, không có `goAway` trước. Cùng mã 1008 với handle sai nên `resume.mjs` phân biệt bằng lý do: lỗi này nối lại với handle như thường |
| `goAway.timeLeft` thực tế | 2026-11-20, `gemini-3.8-live`, có resumption và `slidingWindow`, gửi audio im lặng liên tục: giữ một kết nối **16 phút**, server không gửi `goAway` và không đóng. Tài liệu nói kết nối sống "khoảng 10 phút", nhưng thực tế dài hơn. Trên diễn đàn (2026-10) có báo cáo phiên bị đóng ở 58:00 với `1011 "Deadline expired…"`, `goAway timeLeft=50s` đến trước khoảng 50 giây. Spike 70 phút `live-58.mjs` đang kiểm tra lại |

## 3. myiris làm gì, và ta lấy gì

| myiris | Lấy? | Ở open-iris |
|---|---|---|
| `buildLiveConfig`: `sessionResumption: handle ? {handle} : {}` và `contextWindowCompression` ghi cứng 104857/52428 | **Lấy**, nhưng dùng `slidingWindow: {}` để server tự tính theo model | `liveSetup` trong `live-config.mjs` nhận thêm `handle` |
| Lưu `newHandle` khi `resumable && newHandle` | **Lấy** | Module mới `src/main/resume.mjs` |
| `scheduleReconnect`: backoff `min(500·2^(n-1), 8000)` ms, tối đa 5 lần, từ lần 3 bỏ handle và mở phiên mới | **Lấy** | `resume.mjs` |
| Cờ `userStopped`, Stop xoá timer và handle | **Lấy**, thêm chặn kết nối đang mở dở (mục 6) | `resume.mjs` |
| `isReconnect`: không chào lại khi nối lại | **Lấy** ý: không `SessionStart` lại | `main.mjs` |
| Gửi lại yêu cầu im lặng khi đang 👂 sau mỗi lần nối | **Lấy** | `main.mjs` |
| Khi hết số lần thử thì **không** tắt listen-only (để Iris không bỗng nói to) | **Lấy** | `main.mjs` |
| `goAway` chỉ log, chờ `onclose` | Lấy cho bản đầu. Nối lại chủ động là bước S4, tuỳ chọn | |
| Nằm trong một factory lớn với DI, TypeScript, vitest | **Không** | ESM thuần, một module nhỏ có selftest |

## 4. Quyết định (user chốt 2026-11-20)

1. **Công tắc.** Một công tắc "Giữ phiên dài" cho cả resume và nén context, mặc định **bật**, nằm trong tab Tính năng. Tắt = hành vi như hôm nay. Trong code: `liveSetup(..., { keep, handle })`.
2. **Một "phiên" của plugin là gì.** Tính từ Start tới Stop (hoặc tới khi hết số lần thử). Nối lại, kể cả khi phải mở phiên Gemini mới, **không** bắn lại `SessionEnd`/`SessionStart`, giữ nguyên `session_id`. Không thêm sự kiện mới; hợp đồng hook không đổi.
3. **Setup gửi lại khi nối lại.** Lưu nguyên `config` đã gửi lúc Start (gồm brief có context `SessionStart`) và gửi lại y hệt, chỉ thêm `handle`. Không đọc lại IRIS.md, skill hay plugin, không chạy lại hook. S0 xác nhận: server bỏ qua setup khác khi resume.
4. **Handle không ghi xuống đĩa.** Chỉ giữ trong bộ nhớ. Thoát app là hết phiên.
5. **Không có trần thời gian** cho một phiên.
6. **UI.** Dùng lại `live:status = "connecting"` khi đang nối lại. Không đổi UI.
7. **S4** (nối lại chủ động ở `goAway`) chờ log thực tế.

## 5. Context: cái gì lớn dần và cắt chỗ nào

Đo ngày 2026-11-20 (khoảng 4 ký tự một token):

| Phần | Kích thước | Ở đâu | Bị sliding window cắt? |
|---|---|---|---|
| System instruction lõi + `DESKTOP_BRIEF` (bật đủ 9 tool) | 2.534 ký tự ≈ 650 token | system | Không |
| Khai báo 9 tool | 4.177 ký tự ≈ 1.050 token | setup | Không |
| IRIS.md | tối đa 2.000 ký tự ≈ 500 token | system | Không |
| Danh sách skill | tối đa 20 × (64 + 200) ≈ 1.300 token | system | Không |
| Context `SessionStart` của plugin | **không có trần tổng**: 1.000 ký tự × 5 hook × 20 nhóm × số plugin | system | Không |
| Âm thanh vào/ra | ≈ 32 token/giây | lượt | Có |
| Kết quả tool desktop | tối đa `MAX_CHARS` = 20.000 ký tự ≈ 5.000 token **mỗi lần gọi** | lượt | Có |
| Thân skill (`use_skill`) | tối đa 8.000 ký tự ≈ 2.000 token | lượt (phản hồi tool) | **Có** |
| Context `UserTurn`/`IrisTurn`/`ListenOnlyChanged`/`[gallery]` | tối đa 1.000 ký tự mỗi lần | lượt | **Có** |

Nhận xét:
- Phần cố định khoảng 3.500 token, nhỏ so với 131k. Không cần tóm tắt.
- Phần tăng nhanh nhất là **kết quả tool** (cây giao diện tới 5k token mỗi lần), rồi tới âm thanh. Khoảng 20 lần `find_app_control` là đủ tới ngưỡng nén.
- Sliding window chỉ bỏ phần cũ, không tóm tắt. Thứ gì phải sống suốt phiên thì phải nằm trong system instruction, không nằm trong lượt.

Việc cần làm:
- **Trần tổng cho context `SessionStart`**: ví dụ 4.000 ký tự cho mọi plugin cộng lại, cắt theo thứ tự plugin và ghi log. Sửa ở `hooks.mjs`, cần cập nhật spec mục 3.
- **Prompt skill sai sau khi nén:** `personaBrief` đang nói "Call it once per skill per session; the guide stays with you". Đổi thành "gọi lại nếu bạn không còn thấy hướng dẫn".
- **Trạng thái 👂 và `[gallery]`** nằm trong lượt nên có thể bị cắt. Cổng phía client vẫn là bảo đảm cho 👂. Sau mỗi lần nối lại, gửi lại một lượt im lặng (`turnComplete: false`) nêu trạng thái hiện tại.
- **Kết quả tool lớn:** *chưa làm*. Ghi `// shortcut:` nếu log cho thấy nén xảy ra quá sớm, rồi hạ `MAX_CHARS` cho phản hồi gửi Gemini.

## 6. Hook, Tick và 👂 khi nối lại

| Tình huống | `SessionStart` | `SessionEnd` | `Tick` / lượt `speak` đang chờ | 👂 và 🔇 |
|---|---|---|---|---|
| Start lần đầu | Bắn, trước `connect` (như nay) | | `hooks.start()` lúc `onopen` | tắt |
| Nối lại bằng handle | **Không** | **Không** | Vòng 1 giây **chạy tiếp**, không `stop()`/`start()`. Trong lúc đứt, `send()` trả `false` (session null) nên lượt được giữ và gửi khi có phiên lại | **Giữ**. Gửi lại thông báo 👂 im lặng |
| Handle hỏng, mở phiên Gemini mới | **Không** (dùng lại brief đã lưu) | **Không** | Như trên | Giữ. Gửi lại 👂, `[gallery]`, và một câu "context trước đã mất" |
| Stop | | Bắn một lần | `stop()` | tắt cả hai (như nay) |
| Hết số lần thử | | Bắn một lần | `stop()` | 👂 **giữ** để Iris không tự nói to khi người dùng Start lại (theo myiris) |

- Cần một thay đổi nhỏ ở `hooks.mjs`: `addContext` gọi lúc đang đứt phải được giữ lại và gửi khi nối xong (hôm nay nó bị bỏ qua vì `session?.`). Nếu không thì bỏ, ghi `// shortcut:`. **Đã làm (S5):** chưa giữ được trong `hooks.mjs` vì nó không biết kết nối đứt hay không; đã ghi `// shortcut:` ở `createHooks`, phần giữ làm trong `main.mjs` ở S3.
- `markActivity` tiếp tục chạy, nên lượt `speak` vẫn chờ 4 giây im lặng sau khi nối lại.
- Chu kỳ `Tick` vẫn tính từ `onopen` **đầu tiên**, không reset. Spec mục 4 cần thêm một câu ghi rõ điều này.

## 7. Các trường hợp lỗi

| Trường hợp | Cách xử lý |
|---|---|
| Mạng đứt (`onclose` 1006 hoặc `onerror`) | Backoff 0,5 → 1 → 2 → 4 → 8 giây, tối đa 5 lần. Từ lần 3 bỏ handle và mở phiên mới (theo myiris). Âm thanh mic trong lúc đứt bị bỏ |
| Handle hết hạn hoặc bị từ chối | Hai lần đầu thất bại, từ lần 3 thì mở phiên mới. S0: mã `1008 "session not found"` → bỏ handle ngay |
| Lỗi không đáng thử lại (sai key, hết quota "Resource has been exhausted") | Dừng ngay, không thử lại 5 lần. S0: sai key là `1007`; quota nhận theo chữ, chưa kiểm chứng |
| Người dùng bấm Stop khi đang chờ nối lại | `stopLive` xoá timer và handle, đặt `stopped`. Lời gọi `connect` đang dở mà xong **sau** Stop thì đóng ngay kết nối đó, không gán vào `session`. Dùng số thế hệ (`gen`), như biến `me` hiện nay |
| Bấm Start khi đang nối lại | Không làm gì (như `starting` hiện nay) |
| Tool call đang chạy khi `goAway`/đứt | Tool vẫn chạy xong (thao tác desktop đã xảy ra). Phản hồi bị bỏ vì `s !== session`. Handle cuối là từ **trước** lượt có tool call, nên sau khi nối lại Gemini không biết tool đã chạy và có thể làm lại. **Xử lý:** giữ các phản hồi bị bỏ, sau khi nối gửi một lượt im lặng "[session] Trong lúc nối lại, tool X đã chạy: ok/lỗi". `cancelledCalls` được dọn khi đổi phiên |
| Đứt giữa câu Iris đang nói | Câu đó mất (handle từ trước lượt). Renderer nhận `live:interrupt` để dừng phát |
| Máy ngủ rồi thức (quá 2 giờ) | Handle hết hạn, đi đường mở phiên mới. *Chưa* bắt `powerMonitor` |

## 8. Các bước

Mỗi bước kết thúc bằng `pnpm test` qua. Không đụng `main.mjs`, `preload.cjs`, renderer cho tới khi open-iris-dev xong H4/H5. Chỉ commit khi user bảo.

| # | Việc | Kiểm chứng |
|---|---|---|
| S0 | **Spike** (script trong `scripts/spikes/`, không chạy trong `pnpm test`, tốn quota): (a) resume với system instruction khác có được không; (b) mã lỗi khi handle sai/hết hạn; (c) tool call dở khi đóng kết nối thì sau resume ra sao; (d) `goAway.timeLeft` thực tế với `gemini-3.8-live` | Script thoát khác 0 nếu kết quả không lặp lại. Ghi kết quả vào mục 2 bản này |
| S1 | `liveSetup(lang, tools, brief, { handle, keep })`: thêm `sessionResumption` và `contextWindowCompression: { slidingWindow: {} }` khi `keep` bật | `live-config.selftest.mjs`: `keep` tắt → không có hai khoá; bật, không handle → `sessionResumption: {}`; có handle → `{ handle }` |
| S2 | `src/main/resume.mjs`: `createResumer({ connect, now, setTimeout, log })` giữ handle, đếm lần thử, backoff, `stop()`, số thế hệ. Không biết gì về Electron hay hook | `resume.selftest.mjs` với WebSocket giả và đồng hồ giả: (1) update `resumable:false` không ghi đè handle; (2) đóng → nối lại với handle mới nhất; (3) backoff 500/1000/2000…, lần 3 không có handle; (4) hết 5 lần → gọi `onGiveUp` một lần; (5) Stop khi đang chờ → không connect nữa; (6) connect xong sau Stop → bị đóng, không thành phiên; (7) lỗi quota → không thử lại |
| S3 | Gắn vào `main.mjs` (open-iris-dev, sau H4/H5): `onclose` gọi resumer thay vì `endHooks`; `handleMessage` chuyển `sessionResumptionUpdate`; gửi lại setup đã lưu; lượt im lặng sau khi nối (👂, `[gallery]`, tool đã chạy); `SessionEnd` chỉ ở Stop/hết lượt thử; công tắc `session.keep` trong `clean()` | Selftest của `hooks.mjs`: `start()` một lần, nối lại không reset `Tick`, lượt `speak` giữ qua lúc đứt. `pnpm dev` để phiên chạy **35 phút** (qua mốc 15 phút): log có `resumed` ≥ 3 lần, hỏi lại một chuyện từ phút đầu vẫn trả lời đúng, recap của plugin mẫu đúng nhịp |
| S4 | *(Tuỳ chọn)* Nối lại chủ động khi có `goAway`: chờ lúc im (không tool đang chạy, không đang nói) và có handle `resumable` mới, rồi tự đóng và nối lại | Selftest: `goAway` lúc đang có tool call → chờ xong mới nối; hết `timeLeft` mà chưa im → để server đóng như S2 |
| S5 | Context: trần tổng context `SessionStart` (`hooks.mjs` + spec), sửa câu skill trong `personaBrief`, giữ `addContext` lúc đứt | `hooks.selftest.mjs`: 3 plugin × 5.000 ký tự → bị cắt ở trần, có log. `persona.selftest.mjs` cập nhật câu mới |

Thứ tự: S0, S1, S2, S5 làm được ngay vì không đụng file của open-iris-dev. S3 chờ H4/H5. S4 chỉ làm nếu log cho thấy hay bị cắt giữa câu.

## 9. Rủi ro

- **Resume với setup khác bị từ chối hoặc lặng lẽ bỏ qua.** Đây là lý do gửi lại setup y hệt (quyết định 3). S0 kiểm chứng.
- **Nhầm im lặng thành nhớ:** myiris từng có spike "xanh" mà context mất hết vì đóng kết nối trước khi có handle mới. Kiểm chứng S3 phải hỏi lại chuyện **từ trước** lần nối, không chỉ xem Iris còn trả lời.
- **Tool desktop bị làm hai lần** sau khi nối lại (mục 7). Lượt im lặng giảm rủi ro nhưng không chắc chắn, vì đó là prompt.
- **Sliding window cắt mất thứ đang cần:** hướng dẫn skill, trạng thái 👂 trong hội thoại, context plugin theo lượt. Mọi bảo đảm thật phải nằm ở client (cổng 👂) hoặc trong system instruction.
- **Chi phí:** phiên không giới hạn nghĩa là token không giới hạn. Một giờ nghe liên tục ≈ 115k token âm thanh vào. Không có trần thời gian thì Start rồi quên là tốn tiền.
- **Đụng file với open-iris-dev:** S3 sửa `main.mjs`. Chờ H4/H5 commit trước.

## 10. Câu hỏi cho user

Đã trả lời hết, xem mục 4.

## Liên quan

- `docs/plugin-hooks-spec.md`: mục 4 (sự kiện, `Tick` tính từ `onopen`) cần thêm câu về nối lại; mục 3 cần trần tổng cho context `SessionStart`.
- `docs/plugin-pack-plan.md` mục 5 và `docs/livestream-plugin-plan.md` (L0): trỏ về bản này.
- myiris: `electron/live-session.mjs` (`scheduleReconnect`, `stopLive`), `electron/live-messages.mjs` (`sessionResumptionUpdate`), `openspec/changes/archive/2026-07-28-add-listening-mode/spikes/README.md` (bẫy "đóng trước khi có handle").
