# Mẫu JSON

- [episode.json](episode.json): điền nội dung vào `artifact/episode.json` do lệnh `new` tạo. Giữ mã. Lưu nội dung để copy vào `request` nguyên văn như người dùng gửi; chỉ cập nhật trường này theo bản sửa người dùng đã cho phép. Không thêm đường dẫn ảnh vào slide: script tự ghi ảnh và biên bản theo số trang.
- [character.json](character.json): hồ sơ một mẫu nhân vật/một phiên bản. `characters` trên slide chứa `{id, version}` hoặc `[]` nếu không cần mẫu.

Với `original` không có nguồn ngoài, dùng `source: null`. Với nguồn dịch/kinh, ghi `title`, `translator`, `edition`, `url`, `locator`, `rights` nếu xác định được. `verbatim` cần `source.file` (thường là `source.txt`, tính từ thư mục tập) và chữ khớp nguồn. Không điền nguồn/quyền giả. Chỉ `text` được in lên ảnh; các trường khác dùng làm căn cứ. Xem [biên tập](../docs/editorial.md).
