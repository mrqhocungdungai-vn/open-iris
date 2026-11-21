# Kế hoạch: Hand Task Vision bớt click nhầm

Ngày 2026-11-21. Trạng thái: C1 (độ sâu) và C2 (lòng bàn tay) xong (0f9a101), chờ user thử tay; C0 đo và C3–C5 chờ kết quả. Chủ: iris-vision.

Vấn đề: điều khiển chuột bằng tay quá nhạy. Click trái và nhất là click phải tự nhảy khi người dùng chỉ đang di tay hoặc đổi tư thế.

## 1. Hiện trạng

Click chạy trong `engine.js` (nhánh ✋), logic thuần nằm trong `hand.js`:

- `pinchRatio`: khoảng cách đầu ngón cái tới ngón trỏ (8, click trái) hoặc ngón giữa (12, click phải), chia cho cỡ bàn tay (0→9).
- `isPinched`: ngưỡng có trễ, chụm khi < `PINCH_ON` 0.25, nhả khi > `PINCH_OFF` 0.33.
- `settle`: đổi tư thế (✋ ✌ ✊) chỉ khi thấy 3 frame liên tiếp. Click chỉ đổi trên frame thật sự là ✋.
- `clickLock`: giữ điểm click 500 ms, con trỏ chậm lại khi các ngón khép gần.
- Chỉ cần **một frame** đọc ra là chụm thì `mouse("down")` hoặc `mouse("right")` chạy ngay.

`history.jsonl` chưa có lần sửa nào về pinch hay click, nên kế hoạch này không đụng vào lần sửa cũ nào.

## 2. Nguyên nhân (giả thuyết, đo ở C0)

1. **Khoảng cách 2D.** `dist` trong `hand.js` chỉ dùng x, y. Tay nghiêng hay xoay ngang thì đầu ngón cái chồng lên ngón trỏ hoặc ngón giữa trong ảnh, dù thật ra còn cách xa. Click phải bị nặng nhất vì ngón giữa hay nằm sau ngón cái.
2. **Không chờ giữ.** Một frame nhiễu đủ gây ra một click.
3. **Click lúc tay đang di nhanh.** Lúc đổi tư thế là lúc model đọc sai nhiều nhất (báo cáo CS194 Berkeley).
4. **Click phải không có thời gian nghỉ.** Khi tay rung quanh ngưỡng, nhả ra rồi chụm lại sẽ thành nhiều click phải.

## 3. Các bên khác làm thế nào

| Nguồn | Cách làm |
|---|---|
| Apple (patent "Pinch recognition and rejection") | Xét tư thế bàn tay để biết có chủ ý không, bỏ cú chụm không chủ ý |
| Google Project Gameface | Mỗi hành động có ngưỡng riêng và "trigger delay" (ms) |
| Meta hand guidelines | Có độ trễ trước khi kích hoạt, thời gian nghỉ ~0.25 s giữa hai lần bấm |
| Ultraleap PinchDetector | Ngưỡng vào/ra có trễ (mình đã có) |
| nabeelmusthafawork/handTrack | Chỉ điều khiển khi lòng bàn tay hướng về camera |
| zunza5/handpointer | Chống bấm lặp sau mỗi click |

## 4. Các bước

Mỗi bước là một commit riêng, có test fixture trong `hand.test.mjs`, chạy `pnpm test`, có một id trong `history.jsonl`. Mọi ngưỡng là số hiệu chỉnh phần cứng, lấy từ log C0 và từ lần user thử tay, không đoán.

### C0. Đo trước

- `engine.js` ghi một dòng cho mỗi click: `[gesture] click left|right ratio=… ratio3d=… facing=… speed=… heldMs=…`. Chỉ ghi số, không có dữ liệu cá nhân.
- Bài thử của user (~3 phút, camera và tư thế ngồi như mọi khi):
  - **T1, di tay tự do 60 s** không có ý click (đưa tay qua lại, xoay, nghiêng, ✋ ↔ ✌ ↔ ✊). Đếm số click nhầm.
  - **T2, 20 click trái vào 20 mục** đã định, rồi **10 click phải**. Đếm số click trúng và trượt.
  - **T3, cảm giác độ trễ** từ lúc chụm tới lúc click.
- Kết quả ghi vào §6. Log cắt vào `ops-logs/raw/2026-11-21-vision-false-click.log`.

### C1. Khoảng cách 3D

- `pinchRatio` dùng thêm `z` (tọa độ chuẩn hóa của MediaPipe có z cùng thang với x). Nếu chưa đủ thì đổi sang `worldLandmarks` (đơn vị mét, không phụ thuộc góc camera).
- `PINCH_ON` và `PINCH_OFF` lấy lại từ `ratio3d` đo ở C0.
- Test: fixture tay xoay ngang, hai đầu ngón chồng nhau trong 2D nhưng cách xa theo z, phải ra không chụm. Fixture chụm thật vẫn phải ra chụm.

### C2. Chỉ click khi lòng bàn tay hướng về camera

- `isFacing(lm, side)`: pháp tuyến của mặt phẳng cổ tay (0), gốc ngón trỏ (5), gốc ngón út (17) phải hướng về camera trong một góc giới hạn. Dấu đổi theo tay trái hay tay phải.
- Tay nghiêng quá góc thì con trỏ vẫn di chuyển nhưng không click.
- Test: fixture lòng bàn tay thẳng thì click được, nghiêng 70° thì không.

### C3. Phải giữ mới click

- `LEFT_HOLD_MS` khoảng 60–100 ms (2–3 frame) cho click trái. Kéo thả vẫn bắt đầu sau khoảng giữ này.
- `RIGHT_HOLD_MS` khoảng 250–400 ms cho click phải. Vòng tiến trình sẵn có của HUD (`progress` trong `showPose`) chạy theo thời gian giữ.
- Đổi chữ hay hình trên HUD cần bản xem trước HTML được user duyệt trước.
- Test: chụm 1 frame thì không click, chụm đủ thời gian thì click đúng 1 lần.

### C4. Không click khi tay đang di nhanh

- Tốc độ gốc bàn tay (lm[9]), chia cho cỡ bàn tay, tính theo giây. Lúc bắt đầu chụm mà nhanh hơn ngưỡng thì bỏ cú chụm đó, đến khi nhả ra mới tính lại.
- Test: chuỗi frame tay quét ngang kèm một frame chụm thì không click. Tay dừng rồi chụm thì click.

### C5. Click phải có thời gian nghỉ (chỉ làm nếu C1–C4 chưa đủ)

- Sau một click phải thì bỏ qua chụm ngón giữa ~400 ms. Không áp cho click trái để double-click (500 ms) vẫn chạy.

## 5. Không làm

- Không có thanh trượt độ nhạy trong Settings (chưa ai yêu cầu, số đã hiệu chỉnh sẵn).
- Không đổi model MediaPipe, không thêm dependency, không đụng `src/main/` hay `src/renderer/`.
- Không đổi cử chỉ click phải sang cử chỉ khác (xem câu hỏi ở §7).

## 6. Số đo

| | Trước (C0) | Sau C1+C2 | Sau C3+C4 | Mục tiêu |
|---|---|---|---|---|
| T1 click nhầm / 60 s | | | | giảm ≥ 80 %, tốt nhất là 0 |
| T2 click trái trúng / 20 | | | | ≥ 19 |
| T2 click phải trúng / 10 | | | | ≥ 9 |
| T3 trễ click trái | | | | thêm ≤ 100 ms |
| H1 detect FPS, H3 jitter | | | | không tệ hơn |

## 7. Câu hỏi cho user

1. Click phải phải giữ ~0.3 s có chấp nhận được không? Một cách khác: bỏ chụm ngón giữa, thay bằng chụm ngón trỏ rồi giữ ~0.6 s (giống nhấn giữ trên macOS). Cách này hết hẳn nhầm với ngón giữa, nhưng thay đổi thói quen đang dùng.
2. Thứ tự đề xuất: C0 → C1 → C2 → đo lại → C3 → C4 → đo lại → C5 nếu cần. Đồng ý thứ tự này không?
