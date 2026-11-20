# Handle của Gemini Live và "2 giờ"

Ngày 2026-11-20. Tài liệu giải thích, không phải kế hoạch. Mỗi điều ghi rõ nguồn:

- **[docs]**: tài liệu Google. Trích dẫn đầy đủ ở `docs/session-plan.md` §2.
- **[spike]**: đã thử với API thật bằng `scripts/spikes/`.
- **[chưa kiểm]**: hiểu biết chung, chưa đối chiếu lại.

## 1. Tóm tắt một đoạn

Gemini Live là một kết nối WebSocket **có trạng thái**. Cuộc trò chuyện, tức context window, nằm trên server Google chứ không nằm trong app. App không đọc được chuỗi token đó và cũng không gửi chuỗi token lên được. **Handle** là một chuỗi mã server đưa cho app, giống cái phiếu gửi đồ: khi kết nối đứt, app đưa phiếu ra để server tìm lại đúng cuộc trò chuyện cũ. Phiếu còn hiệu lực **2 giờ kể từ lúc phiên đóng** [docs]. Quá 2 giờ, server xoá trạng thái đó và không cách nào lấy lại.

## 2. Handle hoạt động thế nào

1. Lúc setup, app bật `sessionResumption: {}` [docs].
2. Trong lúc nói chuyện, server gửi định kỳ `sessionResumptionUpdate { newHandle, resumable }` [docs]. App luôn giữ handle mới nhất.
3. Khi kết nối đứt, app mở kết nối mới với `sessionResumption: { handle }`. Server nạp lại trạng thái, và Iris nói tiếp như chưa có gì xảy ra [spike].
4. Trong lúc model đang chạy tool hoặc đang nói, server gửi `resumable: false` và không có handle mới [docs]. Vì vậy handle luôn là trạng thái **trước** lượt đang dở. Đứt giữa câu thì mất câu đó. Tool call đang dở không được gọi lại, và model cứ chờ kết quả của nó [spike]. Vì thế app gửi một ghi chú im lặng (`resumeNote`) để báo cho model biết.

Những điều handle **không** làm:

- **Không đổi được cấu hình.** Nếu app nối lại với system instruction hay danh sách tool khác, server vẫn nhận, không báo lỗi, nhưng lặng lẽ giữ cấu hình cũ [spike]. Muốn đổi model, persona hay tool thì phải mở phiên mới.
- **Không chứa dữ liệu.** Handle chỉ là mã tra cứu. Lưu handle xuống đĩa không phải là lưu cuộc trò chuyện.
- **Không phải session id để mở lại tuỳ ý.** Nó hết hạn sau 2 giờ, và có thể vô hiệu sớm hơn (xem §3).

## 3. Các giới hạn thời gian

Có nhiều đồng hồ khác nhau, rất dễ nhầm:

| Đồng hồ | Con số | Nguồn | Hậu quả |
|---|---|---|---|
| Handle sau khi phiên đóng | 2 giờ | [docs] | Quá hạn thì server trả `1008 "session not found"`, app mở phiên mới |
| Một kết nối | Tài liệu nói "khoảng 10 phút". Thực tế giữ được ít nhất 16 phút | [docs], [spike] | Server cắt kết nối, app nối lại bằng handle |
| Phiên audio **không** nén context | 15 phút | [docs] | Vì vậy "Giữ phiên dài" bật cả nén context (`slidingWindow`) |
| Im lặng (không gửi audio) | 2 phút | [spike] | `1008 "client inactivity"`, nối lại bằng handle như thường |
| Trần một phiên | 58 phút, đóng với `1011 "Deadline expired"` | [spike] 2026-11-20 | Resume bằng handle mở được, nhưng khoảng 2 phút sau server cắt với `1008 "Requested entity already exists"`, và từ đó handle chết (`1008 "session not found"`). Resume chỉ thêm được khoảng 2 phút rồi rớt thêm một lần, nên app mở phiên mới ngay khi gặp 1011 |
| `goAway` (báo trước khi cắt) | Có trường `timeLeft` | [docs], [spike] | Đến ở phút 57:10 với `timeLeft=50s`, tức khoảng 50 giây trước mốc 58:00. Trong 16 phút đầu không có `goAway` nào |

Context window 131.072 token cho cả 3 model đang dùng [docs]. `slidingWindow: {}` cắt ở khoảng 80% (≈104.858) xuống còn khoảng một nửa. System instruction không bao giờ bị cắt [docs]. Con số `promptTokenCount` giảm sau mỗi lần cắt, và đếm tiếp chứ không về 0 sau khi resume [spike]. Context meter hiển thị chính con số này.

## 4. Khác các model khác thế nào

| Loại API | Context nằm ở đâu | Nối tiếp bằng gì | Mở lại sau nhiều ngày |
|---|---|---|---|
| **Gemini Live** (open-iris) | Server, trong phiên WebSocket | Handle, trong 2 giờ | Không |
| Gemini `generateContent`, Claude Messages API, OpenAI Chat Completions [chưa kiểm] | **Ở client.** Mỗi request gửi lại toàn bộ lịch sử | Không cần: client có đủ lịch sử | Được, nếu client lưu lịch sử |
| OpenAI Responses API (`previous_response_id`) [chưa kiểm] | Server lưu từng response | Id của response trước | Được, trong thời gian server còn giữ |
| OpenAI Realtime [chưa kiểm] | Server, trong phiên WebSocket | Theo hiểu biết của tôi, không có cơ chế resume tương đương | Không |

Điểm khác cốt lõi:

- **API thường không có trạng thái.** Claude Code "lưu session" được vì chính nó giữ toàn bộ lịch sử chữ và gửi lại mỗi lần. Model không nhớ gì giữa hai request.
- **Gemini Live có trạng thái** để đạt độ trễ thấp: âm thanh chảy liên tục hai chiều, nên không thể gửi lại toàn bộ lịch sử mỗi lượt. Đổi lại, context bị khoá trên server. App chỉ nối lại được bằng handle, trong thời hạn, và với đúng cấu hình cũ.
- Muốn có cuộc trò chuyện "mở lại sau nhiều ngày" với Live thì app phải tự lưu đầu vào (transcript, kết quả tool) và nạp lại dưới dạng nội dung (`initialHistoryInClientContent`). Đó là một bản dựng lại tốn token, không phải trạng thái cũ, và sắc thái giọng nói bị mất.

## 5. open-iris dùng handle ra sao

User đã chốt ngày 2026-11-20 rằng open-iris **không lưu session**. Context công việc nằm ở Claude Code và các harness khác, những thứ Iris sẽ điều khiển qua plugin. Iris là lớp giọng nói và tay để thay bàn phím và chuột.

- **Start → Stop là một phiên mới.** Handle chỉ giữ trong bộ nhớ và bị xoá khi Stop (`src/main/resume.mjs`).
- **"Giữ phiên dài"** (mặc định bật) dùng handle để tự nối lại khi rớt mạng hoặc khi server cắt kết nối giữa phiên. Nó bật luôn nén context.
- **Nút "↺ Làm mới"** chủ động bỏ handle và mở phiên mới với cùng cấu hình. Iris quên toàn bộ cuộc trò chuyện.
- **Context meter** cho thấy phiên hiện tại đầy đến đâu, kèm vạch nơi server bắt đầu cắt phần đầu.
- **Cách xử lý khi phiên đóng** (`resume.mjs`):
  - Sai key hoặc lỗi cấu hình: dừng hẳn.
  - Handle sai, hết hạn, hoặc mốc 58 phút: bỏ handle và mở phiên mới. Vì vậy một phiên dài nhất khoảng 58 phút, sau đó Iris quên cuộc trò chuyện.
  - Các trường hợp còn lại: thử lại tối đa 5 lần. Từ lần thứ 3 thì bỏ handle.
