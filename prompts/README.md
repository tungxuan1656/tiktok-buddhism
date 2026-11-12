# Prompt cho Pi

Khung chỉ dẫn, không gửi nguyên xi. Thay mọi phần trong ngoặc nhọn bằng dữ
liệu thật, bỏ điều không áp dụng, kiểm tra không còn chỗ giữ chỗ.

- [storyboard.md](storyboard.md): Pi tự lên kịch bản trước khi gọi API.
- [character.md](character.md): API tạo ảnh mẫu nhân vật **không chữ**.
- [illustration.md](illustration.md): API tạo slide **có cả chữ lẫn tranh**.

Nguồn sự thật là yêu cầu người dùng + text đã chốt + hồ sơ nhân vật + phong
cách. Gửi ảnh mẫu thật, không chỉ nhắc tên file. Với slide, gửi đúng đoạn text
của trang cần in, không gửi cả nguồn kinh hoặc toàn bộ tài liệu không cần thiết.
Sau vẽ, Pi phải mở/đọc ảnh đối chiếu; prompt đúng không chứng minh ảnh đúng.
