# Thiết kế nhân vật mới — prompt ảnh

Đây là khung cho **một nhân vật**, không phải cảnh kinh. Không gửi nguyên mẫu
khi chưa điền. Tạo ảnh chân dung/đủ thân rõ diện mạo để dùng làm tham chiếu.
Ảnh mẫu không chữ, ưu tiên nhìn rõ diện mạo và trang phục nhân vật.
Lưu prompt rồi gọi `scripts/draw-image.mjs` theo [hướng dẫn API](../references/painter-local-api.md);
xem JPEG95 sau nén, không tự gọi API hoặc đổi/nén ngoài wrapper.

---

Thiết kế một nhân vật minh họa 2D duy nhất: {tên/vai trò}.
Đây là thiết kế minh họa, không khẳng định diện mạo lịch sử.
Nét bút mảnh với chất liệu chì màu, màu dịu, nền trắng, biểu cảm tiết chế.
Không ảnh chụp, 3D, anime hoặc hiệu ứng bóng bẩy.

Ảnh tham chiếu gửi kèm và vai trò:
{liệt kê đúng thứ tự; ảnh phong cách chỉ định nét/màu, không sao chép chữ,
nhân vật phụ, bố cục nhóm hoặc đồ vật; ảnh góc khác nếu có là cùng nhân vật}.

Nhận diện cần giữ:
- Khuôn mặt/độ tuổi biểu kiến: {mô tả cụ thể}.
- Tóc/đặc điểm đầu: {mô tả cụ thể}.
- Vóc dáng và tỷ lệ: {mô tả cụ thể}.
- Trang phục và màu sắc: {mô tả cụ thể, tránh mơ hồ}.
- Chi tiết phân biệt với nhân vật đã có: {đặc điểm}.

Tư thế {tư thế đơn giản}; mặt và trang phục nhìn rõ, không bị che.
Một nhân vật, không người phụ, không khung, không logo, không chữ/ký tự,
không bệ/cây/hào quang/phụ kiện trừ khi được yêu cầu rõ ở trên.
Giải phẫu tự nhiên; không tay/chân thừa, không méo mặt.

---

Sau khi xem ảnh, Pi ghi lại **những gì thật sự xuất hiện** trong character.json,
không chỉ chép lại mong muốn trong prompt. Nếu ảnh sai đặc điểm bắt buộc thì
sửa ảnh, không sửa hồ sơ để hợp thức hóa lỗi. Lưu generated và dùng ảnh thật
đó trong các cảnh. Người dùng chưa duyệt không ngăn làm tiếp.
