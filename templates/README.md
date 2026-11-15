# JSON mẫu

Pi sao chép rồi điền, người dùng không phải soạn JSON.

- [character.json](character.json): nhận diện một nhân vật/một phiên bản.
- [episode.json](episode.json): một kịch bản, text đúng và ảnh từng slide.

Giá trị trong ngoặc nhọn là chỗ giữ chỗ; không gửi nguyên vào API hoặc xuất
thành nội dung thật. Không có nghĩa nhân vật/tập trong mẫu đã tồn tại.

`mode` là `original`, `adaptation` hoặc `verbatim`. Với original không có
nguồn ngoài dùng `source: null`. Hai mode còn lại điền object nguồn, ví dụ:

    {
      "title": "{Tên tài liệu/kinh}",
      "translator": "{Dịch giả nếu có}",
      "edition": "{Ấn bản nếu có}",
      "url": "{URL hoặc nguồn do người dùng cung cấp}",
      "locator": "{Phần/đoạn/trang}",
      "rights": "{Cơ sở quyền dùng, hoặc ghi rõ chưa xác định}",
      "file": "source.txt"
    }

`verbatim` cần source.file UTF-8 đã đối chiếu, nối text các slide khớp nguồn.
Không bỏ trống rồi coi như đã xác minh. Không tự điền URL/ấn bản/quyền giả.
Bất kể mode của tập, lời Đức Phật/lời kinh phải nguyên văn từ nguồn đã đối
chiếu; phần lời bình phải tách rõ, không gán thành lời Phật. Số slide theo
đúng nội dung, không có mặc định; tối đa 35 ảnh/tập tính cả bìa/trang kết.

Mỗi slide có `text`, `scene`, `scene_type`, `evidence`, `characters`,
`image`. `characters` là mảng `{id, version}`; cảnh không có người dùng `[]`.
Đường dẫn image/source.file tính từ thư mục chứa episode.json gốc của tập;
snapshot trong output giữ các đường dẫn đó như hồ sơ, không đổi gốc theo output.

`title`, `request`, `source` và `evidence` là dữ liệu quản lý/đối chiếu, không
tự động in trên ảnh. `text` phải qua cổng biên tập trong WORKFLOW: chỉ nội
dung dành cho người xem, không mã tập tự đặt hay lời nói với người giao việc.

`text` gửi vào prompt để AI in trên ảnh; `image` trỏ tới ảnh AI trả về có cả
tranh/chữ. Pi đọc ảnh và kiểm tra, không có renderer/schema engine/database.
