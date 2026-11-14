# Phong cách hiện hành

## Tranh và bố cục

- Minh họa Phật giáo 2D; nét mảnh, chất liệu chì màu, vàng đất/nâu dịu.
  Không ảnh chụp, 3D, anime hoặc hiệu ứng bóng bẩy.
- Nền trắng/giấy sáng, thoáng; biểu cảm trang nghiêm, hiền hòa, tiết chế.
- Khung dọc 3:4; thành phẩm **JPEG quality 95, 1080 × 1440**, chroma 4:4:4.
  Dùng [wrapper API](painter-local-api.md) để giữ raw, đo ảnh, fit + padding và
  nén ngay trong script; không crop/méo/chèn chữ hoặc mã hóa lại khi xuất. PNG
  cũ vẫn hợp lệ, không tự chuyển đổi kho. Phải kiểm tra chữ sau nén.
- **Bố cục linh hoạt theo nội dung**, không bắt buộc tỷ lệ vùng chữ/tranh hay
  vị trí trên/dưới cố định. Sắp xếp để tranh và chữ hiển thị đầy đủ, rõ ràng,
  cân đối; không che nhau hoặc bị cắt khỏi khung. Không thu nhỏ chữ để ép bố cục.
- Một cảnh dễ đọc, ít chi tiết; không khung, bong bóng thoại, logo/watermark.
  Không tự thêm cây, hào quang, bệ đá chỉ vì ảnh ví dụ có chúng.
- Mặt, tóc, tỷ lệ, y phục theo JSON và ảnh mẫu đúng phiên bản. Được đổi tư thế
  theo cảnh; không bắt buộc chép nền/bố cục của ảnh định danh.

## Chữ do AI vẽ ngay trên slide

- `text` phải qua cổng biên tập trong WORKFLOW: nội dung sẵn sàng đăng cho
  độc giả, không mã tập/phần quản lý, trạng thái hoặc lời nói với chủ bot.
  Nguồn trên ảnh ghi đúng tên sách/kinh, không "bản bạn cung cấp".
- Đưa đúng nội dung `text` vào prompt. Chỉ đoạn đó được in, không thêm chữ phụ.
- Chữ nâu sẫm gần `#4B2F1E`, nét rõ, mềm, canh giữa, lề thoáng. Ưu tiên
  kiểu chữ dễ đọc hỗ trợ tiếng Việt đầy đủ, đồng nhất qua các trang.
- Mục tiêu tương đương cỡ 44–52 px trên 1080 px ngang, không chữ bé li ti.
  Đây là chỉ dẫn hình ảnh, không phải tham số model bảo đảm. Thường 20–40 từ,
  khoảng 4–6 dòng; nhiều hơn thì chia trang trước khi vẽ.
- Không tự sửa dấu, đổi từ, thêm dấu ngoặc kép hoặc viết hoa toàn bộ. Ngắt
  dòng được phép để vừa bố cục, không bỏ/thêm nội dung.
- Pi mở ảnh, đọc từng dòng và so với text chuẩn. Lỗi chữ/dấu thì sửa ảnh,
  không thêm renderer/ghép chữ bằng phần mềm để thay cách người dùng đã chọn.

## Tham chiếu và lịch sử

Mở [ảnh ví dụ gốc](user-style-v1/example-01-original.png) để hiểu nét vẽ/màu/bố
cục. Không lấy chữ trong ảnh làm nguồn kinh hoặc sao chép mọi đồ vật trong đó.
Ảnh gốc 765 × 1024 không phải kích thước đầu ra.

[Hồ sơ gốc](user-style-v1/README.md) được giữ nguyên để truy nguyên. Các quy tắc
cũ “minh họa không chữ”, “ghép chữ riêng”, “duyệt mẫu trước” và chia vùng
chữ/tranh theo tỷ lệ cố định **không còn là yêu cầu hiện hành**.
AGENTS/WORKFLOW hiện tại thực hiện lựa chọn mới của người dùng:
AI tạo cả tranh/chữ, Pi tự đọc ảnh, người dùng xem thành phẩm cuối lượt.
