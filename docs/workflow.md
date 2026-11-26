# Quy trình làm tập

## Soạn và chốt chữ

1. Nhận đầu bài trong phiên agent. Với tập mới chạy `node scripts/episode-tools.mjs new "Tên tập" "Nội dung người dùng gửi"`. `request` là bản để copy trên Telegram: giữ nguyên phần nội dung, không kèm lệnh hay chỉ dẫn sản xuất. Chỉ cập nhật `request` theo bản sửa người dùng đã cho phép. Script cấp mã từ thư mục hiện có; không tự đặt mã hoặc in mã lên slide.
2. Dùng bản đầy đủ, rõ ràng do người dùng gửi làm nguồn, không tự tra lại kho nguồn hay web (xem [biên tập](editorial.md)), rồi viết đủ trang trực tiếp vào `episodes/Tn/artifact/episode.json` theo [mẫu](../templates/README.md); không chép cả kịch bản ra chat. Chia dòng/trang ở chỗ tự nhiên để chữ dễ đọc mà không đổi lời nguồn. Dùng [mẫu phong cách hiện hành](visual-style.md) và chỉ mở ảnh/JSON [nhân vật](../characters/README.md) cần dùng hoặc cần đối chiếu để chọn mẫu, rồi ghim đúng snapshot. Không mở hàng loạt tập cũ hay đọc mã CLI nếu tài liệu và lệnh chuẩn đủ dùng.
3. Chạy `node scripts/episode-tools.mjs validate episodes/Tn` rồi `node scripts/episode-tools.mjs lock episodes/Tn`. Kịch bản là bản duy nhất. Script khóa nội dung và dấu vân tay nguồn/tham chiếu. Không cần người dùng duyệt trước khi vẽ.

## Từng ảnh một

1. Khi vào lại tập, chạy `node scripts/episode-tools.mjs handoff episodes/Tn` (`status` cùng kết quả). Handoff dẫn tới đúng việc: hoàn thiện kịch bản, vẽ, kiểm ảnh đã có, sửa, đối soát lỗi, hoặc chốt. Không đọc lại toàn bộ lịch sử hay vẽ lại trang đã đạt.
2. Với trang cần vẽ/sửa, chạy `node scripts/draw-image.mjs --slide episodes/Tn N`. Wrapper dùng đúng chữ và ảnh tham chiếu đã lưu. Nếu API lỗi hoặc kết quả chưa rõ, không sang trang khác; xem [phục hồi](image-api.md).
3. Mở đúng JPEG đã nén. So từng dòng, ký tự nhìn thấy, dấu và dấu câu với `slides[N-1].text`; phóng to nếu chưa đọc được. So chữ với mẫu phong cách, khả năng đọc trên điện thoại, bố cục và mẫu nhân vật. Không coi ảnh API trả về là đã đạt.
4. Đạt: chạy `node scripts/export-slide.mjs --checked episodes/Tn drafts/NNN-aK/image.jpg "ghi chú ngắn về chữ, bố cục và nhân vật"`. Lỗi: chạy `node scripts/episode-tools.mjs reject episodes/Tn drafts/NNN-aK/image.jpg --note "mô tả lỗi cụ thể"`. Dùng đường dẫn của lượt ảnh vừa kiểm. Ghi ngay trước khi sang trang; không chép lại biên bản từng trang vào `notes.md`. Dùng `notes.md` cho nguồn, quyết định đáng lưu và xác nhận của người dùng khi có. Chỉ sửa trang lỗi; không sửa chữ trong kịch bản theo lỗi model. Báo tiến độ gọn mỗi 5–10 trang mới đạt, hoặc báo ngay khi bị chặn.
5. Khi handoff trả `finalize`, chạy `node scripts/episode-tools.mjs finalize episodes/Tn`. Chỉ bàn giao `ready_for_review` khi hash các ảnh và biên bản đều khớp kịch bản. Không cần mở lại toàn bộ ảnh đã kiểm. Cho người dùng đường dẫn và số ảnh; [bot](telegram.md) tự báo xong.

Khi có log sẵn và số liệu cùng cách tính, so nhanh với T36 để biết phần nào tiết kiệm hơn: token đầu vào ngoài cache (690.689), lượt vẽ slide/trang đạt (34/30, không tính lượt tạo mẫu nhân vật), và trung vị thời gian từ khi có JPEG đến request ảnh kế tiếp (33,8 giây). Không thêm lượt gọi, không trì hoãn bàn giao để lấy số liệu, và không coi token là chi phí thực trả.

## Sửa và trạng thái

- Được yêu cầu sửa: chạy `reopen` với cùng thư mục, sửa kịch bản hoặc ghi lỗi cụ thể với ảnh cần sửa; nếu sửa nội dung để copy, cập nhật `request`. Khóa lại rồi theo handoff. Nội dung/trang và mẫu không đổi giữ nguyên biên bản. Bot không gửi bộ ảnh khi đang sửa.
- `publish` chỉ chạy khi người dùng bấm nút “Đã đăng bài” trên Telegram hoặc xác nhận đúng thành phẩm đã đăng trong phiên agent (ghi xác nhận vào `notes.md`); hoàn thành (`ready_for_review`) không đồng nghĩa đã đăng. Không còn trạng thái trung gian `approved`.
- Lưu kịch bản, nguồn/ghi chú, mẫu đã ghim, ảnh chốt, biên bản và dữ liệu cần phục hồi. Không tạo revision/snapshot kịch bản thứ hai. Không xóa dữ liệu khi API hay chuyển giao chưa rõ; không tự dọn hồ sơ lịch sử. Git không theo dõi dữ liệu tập.
