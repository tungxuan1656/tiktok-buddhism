# Kho nhân vật: JSON + ảnh thật

Kho này là trí nhớ dùng lại qua các phiên Pi. JSON mô tả nhận diện; ảnh thật
mới là thứ gửi model. Không cái nào thay thế cái còn lại.

## Cấu trúc

	PHAT_01/v1/character.json
	PHAT_01/v1/reference.jpg

Mỗi người lặp lại một ID. Một thiết kế một phiên bản `v1`, `v2`...;
không đặt nhiều người khác nhau vào một mã `NHOM_01`. Với nhóm, tạo từng mã
thành phần khi thực sự cần. Dùng [mẫu JSON](../templates/character.json).
Đường dẫn trong `references` tính từ thư mục chứa `character.json`.

## Dùng lại trước, tạo mới khi thiếu

1. Tìm theo ID, tên và aliases; mở JSON cùng ảnh. Nếu người dùng chỉ định
   phiên bản thì dùng đúng bản đó; tập đang sửa dùng snapshot đã lưu.
2. Với tập mới không chỉ định: chọn phiên bản số lớn nhất có trạng thái
   `user_approved`; nếu chưa có, chọn phiên bản số lớn nhất `generated`.
   Không chọn `retired`. Đừng chọn theo thứ tự chữ (`v10` phải sau `v9`).
3. Không có mẫu: tự thiết kế theo [prompt](../prompts/character.md) bằng
   [wrapper API](../references/painter-local-api.md), xem JPEG95 sau nén,
   ghi ngoại hình thực, lưu `generated` rồi tiếp tục làm slide. Không chờ người
   dùng duyệt nhân vật. Ảnh mẫu không chữ, ưu tiên nhìn rõ diện mạo và trang phục.
4. Mỗi request vẽ/sửa gửi lại ảnh thật và `identity`/`keep`. Giữ khuôn mặt,
   tóc, tỷ lệ và trang phục; chỉ đổi những gì `can_vary` cho phép.
5. Người dùng đổi thiết kế: tạo phiên bản mới, không ghi đè ảnh cũ. Ghi rõ
   phiên bản cũ đã bị thay thế (`retired` nếu họ bỏ nó) để không chọn nhầm.
   Tập cũ vẫn có snapshot và giữ nguyên hình cũ.

## Trạng thái không phải cổng duyệt

- `generated`: Pi tạo/tự kiểm tra, dùng được, chưa có duyệt của người dùng.
- `user_approved`: người dùng đã thực sự xác nhận đúng mẫu này; ghi bằng
  chứng/ngày trong `review_note`. Đừng suy diễn từ việc họ duyệt một tập.
- `retired`: không chọn cho tập mới, giữ lại để truy nguyên.

## Mẫu hiện có

[PHAT_01/v1/character.json](PHAT_01/v1/character.json) dùng ảnh thử đã có sẵn,
trạng thái `generated`. Đây là quy ước minh họa Đức Phật của dự án, không
khẳng định diện mạo lịch sử. Không phải đã được người dùng duyệt.

Các mã gợi ý còn thiếu: `TYKHEO_01` (Tỷ kheo), `CUSI_01` (cư sĩ). Chỉ tạo
khi nội dung cần. Nhân vật phải có đủ ảnh thật; không tạo hồ sơ giả cho đẹp cây
thư mục. Ảnh phong cách gốc không thay thế hồ sơ nhân vật khác.

## Lưu lâu dài

Commit kho nhân vật cùng repo khi người dùng yêu cầu commit. Không mặc định
lưu ảnh riêng tư của người thật vào Git; cần sự đồng ý về quyền sử dụng và
cách lưu. Mỗi tập giữ snapshot ảnh/JSON đã dùng để tiếp tục được dù kho thay đổi.
