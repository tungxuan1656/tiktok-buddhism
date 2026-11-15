# Lên kịch bản — chỉ dành cho Pi

Từ yêu cầu của người dùng, tạo một chuỗi slide có mạch, mỗi trang một ý.
Không tạo bản kịch bản thứ hai trong chat nếu đã lưu đủ ở episode.json.

1. Xác định mode original/adaptation/verbatim. Lời Đức Phật/lời kinh luôn
   phải nguyên văn theo nguồn/bản dịch đã đối chiếu; không tóm tắt, diễn
   giải, thay từ hoặc lược chữ trong lời trích. Tách rõ lời bình do Pi viết,
   không gán thành lời Phật hay thay cho phần nguồn cần trích. Thiếu nguồn
   chính xác thì hỏi, không dựa vào trí nhớ.
2. Không có số slide mặc định. Chia theo đúng nội dung, đủ ý và dễ đọc;
   tối đa 35 ảnh mỗi tập/revision tính cả bìa/trang kết nếu có. Đếm trước
   khi vẽ, không kéo dài hay rút ngắn nội dung để đạt số trang. Chia nguyên
   văn thành các đoạn liên tiếp, không sửa/bỏ chữ để ép số trang. Nếu không
   vừa 35 ảnh mà vẫn dễ đọc, báo cần chia nhiều tập và hỏi phạm vi, không
   tự cắt nội dung, thu nhỏ chữ hoặc vượt trần.
3. Mỗi trang viết text cuối, một cảnh ít chi tiết, scene_type và evidence.
   evidence chỉ rõ căn cứ đoạn nguồn, hoặc ghi minh họa/ẩn dụ/hư cấu do Pi đề xuất.
   `text` là nội dung để đăng cho người xem, không phải lời nói với chủ bot.
   Áp dụng cổng biên tập trong WORKFLOW: không in nhãn quản lý như "Tập 1 -
   phần 1.1", câu "Nguyên văn theo bản bạn cung cấp", tiến độ hay lời xác
   nhận nội bộ. Tên tập, yêu cầu, evidence không tự trở thành chữ trên ảnh.
   Nếu ghi nguồn thì dùng tên sách/kinh đúng; không tự sửa lời trích thật,
   không bỏ nhãn diễn giải/hư cấu cần thiết để người xem không hiểu lầm.
4. Tìm kho nhân vật trước; chọn ID/version thực sự có hoặc tạo mẫu còn thiếu.
   Không dùng một tên chung để model tùy ý đổi diện mạo mỗi trang.
5. Cảnh không cần người thì không thêm người. Nhiều người thì định danh từng
   người lặp lại; quần chúng không lặp lại mô tả rõ là nhân vật nền.
6. Tự kiểm tra đủ mở đầu/diễn tiến/kết phù hợp nội dung, không trùng ý, không
   trang nhồi chữ, không ví dụ bị mô tả thành sự kiện lịch sử. Đọc từng câu
   như độc giả không biết cuộc trò chuyện: bỏ chữ thừa và lời nội bộ trước
   khi khóa text; không đợi ảnh đã vẽ mới xét nội dung có phù hợp đăng không.

Lưu toàn bộ slides[] theo templates/episode.json trước mọi lượt API. Wrapper
bắt buộc nhận file JSON và số slide (hoặc chế độ nhân vật), kiểm tra 1-35
trang trước POST; không vẽ trang ngoài kịch bản. Sau đó tự tiếp tục vẽ. Chỉ hỏi nếu thiếu thông tin
thật sự ảnh hưởng tính đúng đắn; không hỏi duyệt kịch bản theo mặc định.
