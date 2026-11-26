# Phong cách hiện hành

## Tranh và bố cục

- Minh họa Phật giáo 2D; nét mảnh, chất liệu chì màu, vàng đất/nâu dịu.
  Không ảnh chụp, 3D, anime hoặc hiệu ứng bóng bẩy.
- Nền giấy gần trắng, sáng trung tính và thoáng; không phủ tông kem/vàng
  hoặc tô kín nền bằng phong cảnh. Biểu cảm trang nghiêm, hiền hòa, tiết chế.
- Khung dọc 3:4; thành phẩm **JPEG quality 95, 1080 × 1440**, chroma 4:4:4.
  Dùng [wrapper API](image-api.md) để giữ raw, đo ảnh, fit + padding và
  nén ngay trong script; không crop/méo/chèn chữ hoặc mã hóa lại khi xuất. PNG
  cũ vẫn hợp lệ, không tự chuyển đổi kho. Phải kiểm tra chữ sau nén.
- **Bố cục linh hoạt theo nội dung**, không bắt buộc tỷ lệ vùng chữ/tranh hay
  vị trí trên/dưới cố định. Sắp xếp để tranh và chữ hiển thị đầy đủ, rõ ràng,
  cân đối; không che nhau hoặc bị cắt khỏi khung. Không thu nhỏ chữ để ép bố cục.
- Một cụm minh họa gọn, ít chi tiết, chừa khoảng trắng rõ giữa tranh và chữ;
  dùng nét chì nhẹ thay vì mảng màu dày. Không khung, bong bóng thoại,
  logo/watermark. Không thêm cây, hào quang, bệ đá chỉ vì ảnh mẫu có chúng.
- Mặt, tóc, tỷ lệ, y phục theo JSON và ảnh mẫu đúng phiên bản. Được đổi tư thế
  theo cảnh; không bắt buộc chép nền/bố cục của ảnh định danh.

## Chữ do AI vẽ ngay trên slide

- `text` phải qua cổng biên tập trong [biên tập](editorial.md): nội dung sẵn sàng đăng cho
  độc giả, không mã tập/phần quản lý, trạng thái hoặc lời nói với chủ bot.
  Nguồn trên ảnh ghi đúng tên sách/kinh, không "bản bạn cung cấp".
- Đưa đúng nội dung `text` vào prompt. Chỉ đoạn đó được in, không thêm chữ phụ.
- Cả bìa lẫn trang nội dung dùng chữ **không chân**, nét tròn mềm, đều nét,
  hơi giống chữ viết tay nhưng rõ dấu tiếng Việt. Chữ nâu sẫm gần `#4B2F1E`,
  canh giữa, lề thoáng, nhất quán qua các trang. Không dùng chữ có chân
  (serif), kiểu chữ sách cổ hoặc nét đậm nặng.
- Mục tiêu tương đương cỡ 44–52 px trên 1080 px ngang, không chữ bé li ti.
  Đây là chỉ dẫn hình ảnh, không phải tham số model bảo đảm. Chia trang
  theo nội dung và độ dễ đọc, không có số slide mặc định. Lời Đức Phật/lời
  kinh phải giữ nguyên văn từ nguồn đã đối chiếu; tăng trang khi cần, không
  rút gọn lời trích hoặc thu nhỏ chữ để ép vừa. Tối đa 35 ảnh/tập theo [quy trình](workflow.md).
- Không tự sửa dấu, đổi từ, thêm dấu ngoặc kép hoặc viết hoa toàn bộ. Ngắt
  dòng được phép để vừa bố cục, không bỏ/thêm nội dung.
- Agent mở ảnh, đọc từng dòng và so với text chuẩn. Lỗi chữ/dấu thì sửa ảnh,
  không thêm renderer/ghép chữ bằng phần mềm để thay cách người dùng đã chọn.

## Tham chiếu và lịch sử

Mở [ảnh ví dụ gốc](../references/user-style-v1/example-01-original.png) và gửi ảnh thật với
vai trò **chỉ tham chiếu phong cách** khi vẽ hoặc sửa slide. Có thể dùng ảnh đã
được người dùng xác nhận đúng phong cách cho công việc đó: lưu bản sao trong
thư mục tập rồi đặt `style_ref` là đường dẫn tương đối trong `artifact/episode.json`
(ví dụ `references/style.jpg`) trước khi `lock`. Script khóa hash ảnh này; nếu
không đặt `style_ref` thì dùng ảnh ví dụ gốc. Mẫu định danh vẫn được gửi riêng; ảnh phong cách chỉ hướng dẫn kiểu chữ, nét chì, màu nền và
khoảng trắng. Không chép nội dung chữ, người hay vật từ ảnh phong cách. Ảnh
ví dụ 765 × 1024 không phải kích thước đầu ra.

Khi xem ảnh sau nén, so cả kiểu chữ, nền giấy và độ thoáng với mẫu phong cách.
Chữ có chân, nền phủ kem/vàng hoặc cảnh quá dày chi tiết là lỗi phong cách,
kể cả khi chữ đã đúng nguyên văn.

[Hồ sơ gốc](../references/user-style-v1/README.md) được giữ nguyên để truy nguyên. Các quy tắc
cũ “minh họa không chữ”, “ghép chữ riêng”, “duyệt mẫu trước” và chia vùng
chữ/tranh theo tỷ lệ cố định **không còn là yêu cầu hiện hành**.
Quy trình hiện hành: AI tạo cả tranh/chữ, agent tự đọc từng ảnh, người dùng xem thành phẩm.
