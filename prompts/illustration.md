# Slide hoàn chỉnh có chữ — prompt ảnh

Điền từ `episode.json` + `character.json` (text đã qua cổng biên tập WORKFLOW, 1–35 slide). Lưu prompt rồi gọi `node scripts/draw-image.mjs --slide EPISODE_JSON SLIDE_NUMBER PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]`. Mở và gửi ảnh phong cách thật theo [chuẩn hiện hành](../references/style.md) cùng ảnh định danh nhân vật.

---

Tạo 1 slide minh họa Phật giáo 2D hoàn chỉnh (khung dọc 3:4, mục tiêu 1080 × 1440), có đúng đoạn chữ tiếng Việt bên dưới.
- Phong cách: nét chì màu mảnh, vàng đất/nâu dịu; nền giấy gần trắng, sáng trung tính, không phủ kem/vàng; 1 cụm minh họa gọn, ít chi tiết, nhiều khoảng trắng; biểu cảm trang nghiêm, hiền hòa. Không ảnh chụp, 3D, anime, khung, bong bóng thoại, logo, watermark hay chữ trang trí.
- Bố cục & chữ: bố cục linh hoạt, tranh và chữ đầy đủ, rõ ràng, không che nhau/cắt mép; không thu nhỏ chữ để ép khung. Dùng chữ KHÔNG CHÂN, nét tròn mềm, đều nét, hơi giống chữ viết tay, rõ dấu tiếng Việt, cỡ tương đương 44–52 px khi xuất, màu nâu sẫm `#4B2F1E`, canh giữa, lề thoáng. Không dùng serif, chữ sách cổ hoặc nét đậm nặng.

CHỮ CẦN IN — chỉ in nguyên văn phần giữa hai dòng phân cách (không in dòng phân cách/nhãn, không sửa/thêm/bớt từ hay dấu, không thêm ngoặc kép/tiêu đề/số trang/chú thích, không chép chữ từ ảnh mẫu):
--- BẮT ĐẦU VĂN BẢN ---
{text nguyên văn của slide}
--- KẾT THÚC VĂN BẢN ---

Ảnh tham chiếu gửi kèm (theo đúng thứ tự, tối đa 10 ảnh):
{1. ID/version và vai trò; 2. ID/version và vai trò; ...}.
Giữ đúng khuôn mặt, tóc, vóc dáng, y phục từ ảnh định danh và không sao chép tư thế/nền mẫu nếu khác cảnh; ảnh phong cách chỉ tham chiếu nét chì, kiểu chữ, nền và độ thoáng.

Loại cảnh: {event/simile/concept}. {Nếu simile/concept: Hình biểu trưng, không dựng thành sự kiện lịch sử.}
Cảnh: {một hành động chính, vị trí cụ thể}.
Nhân vật: {ID/version + đặc điểm bắt buộc + vị trí, hoặc không có}.
Vật thể được phép: {danh sách ngắn hoặc không có}. Không thêm người, vật thể, hào quang hay hiệu ứng ngoài danh sách.

---

Sau khi nhận ảnh, Pi đọc kiểm tra từng dòng chữ, dấu, nhân vật và phong cách. Khi sửa: nêu rõ lỗi cần sửa, gửi lại toàn bộ text đúng + ảnh mẫu (có thể kèm ảnh nháp làm tham chiếu bố cục cần sửa).
