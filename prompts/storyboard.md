# Lên kịch bản — chỉ dành cho Pi

Từ yêu cầu của người dùng, tạo một chuỗi slide có mạch, mỗi trang một ý.
Không tạo bản kịch bản thứ hai trong chat nếu đã lưu đủ ở episode.json.

1. Xác định mode original/adaptation/verbatim. Có nguồn thì kiểm chứng và ghi
   nguồn. Không tự gán lời do mình viết thành lời Phật hoặc lời kinh.
2. Mặc định 5 trang, điều chỉnh theo lượng nội dung. Diễn giải thì ngắn, dễ
   hiểu, không giật gân và không ép thành bài học đạo đức mà nguồn không nói.
   Nguyên văn thì chia các đoạn liên tiếp, không sửa hay bỏ chữ để ép số trang.
3. Mỗi trang viết text cuối, một cảnh ít chi tiết, scene_type và evidence.
   evidence chỉ rõ căn cứ đoạn nguồn, hoặc ghi minh họa/ẩn dụ/hư cấu do Pi đề xuất.
4. Tìm kho nhân vật trước; chọn ID/version thực sự có hoặc tạo mẫu còn thiếu.
   Không dùng một tên chung để model tùy ý đổi diện mạo mỗi trang.
5. Cảnh không cần người thì không thêm người. Nhiều người thì định danh từng
   người lặp lại; quần chúng không lặp lại mô tả rõ là nhân vật nền.
6. Tự kiểm tra đủ mở đầu/diễn tiến/kết phù hợp nội dung, không trùng ý, không
   trang nhồi chữ, không ví dụ bị mô tả thành sự kiện lịch sử.

Lưu theo templates/episode.json rồi tự tiếp tục vẽ. Chỉ hỏi nếu thiếu thông tin
thật sự ảnh hưởng tính đúng đắn; không hỏi duyệt kịch bản theo mặc định.
