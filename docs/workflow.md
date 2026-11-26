# Quy trình làm tập

## Soạn và chốt chữ

1. Nhận đầu bài trong phiên agent. Với tập mới chạy `node scripts/episode-tools.mjs new "Tên tập" "Yêu cầu nguyên gốc"`. Script cấp mã từ thư mục hiện có; không tự đặt mã hoặc in mã lên slide.
2. Viết đủ trang vào `episodes/Tn/artifact/episode.json` theo [mẫu](../templates/README.md), giữ nguồn/ghi chú trong thư mục tập. Soát [biên tập](editorial.md) và [phong cách](visual-style.md), tìm hoặc tạo [nhân vật](../characters/README.md) và lưu đúng snapshot.
3. Chạy `node scripts/episode-tools.mjs validate episodes/Tn` rồi `node scripts/episode-tools.mjs lock episodes/Tn`. Kịch bản là bản duy nhất. Script khóa nội dung và dấu vân tay nguồn/tham chiếu. Không cần người dùng duyệt trước khi vẽ.

## Từng ảnh một

1. Khi vào lại tập, chạy `node scripts/episode-tools.mjs handoff episodes/Tn` (`status` cùng kết quả). Handoff dẫn tới đúng việc: hoàn thiện kịch bản, vẽ, kiểm ảnh đã có, sửa, đối soát lỗi, hoặc chốt. Không đọc lại toàn bộ lịch sử hay vẽ lại trang đã đạt.
2. Với trang cần vẽ/sửa, chạy `node scripts/draw-image.mjs --slide episodes/Tn N`. Wrapper dùng đúng chữ và ảnh tham chiếu đã lưu. Nếu API lỗi hoặc kết quả chưa rõ, không sang trang khác; xem [phục hồi](image-api.md).
3. Mở đúng JPEG đã nén. So từng dòng, ký tự nhìn thấy, dấu và dấu câu với `slides[N-1].text`; phóng to nếu chưa đọc được. So chữ với mẫu phong cách, khả năng đọc trên điện thoại, bố cục và mẫu nhân vật. Không coi ảnh API trả về là đã đạt.
4. Đạt: chạy `node scripts/export-slide.mjs --checked episodes/Tn drafts/NNN-a1/image.jpg "ghi chú kiểm chữ, bố cục và nhân vật"`. Lỗi: chạy `node scripts/episode-tools.mjs reject episodes/Tn drafts/NNN-a1/image.jpg --note "mô tả lỗi cụ thể"`. Ghi ngay trước khi sang trang; chỉ sửa trang lỗi. Không sửa chữ trong kịch bản theo lỗi model.
5. Khi handoff trả `finalize`, chạy `node scripts/episode-tools.mjs finalize episodes/Tn`. Chỉ bàn giao `ready_for_review` khi hash các ảnh và biên bản đều khớp kịch bản. Không cần mở lại toàn bộ ảnh đã kiểm. Cho người dùng đường dẫn và số ảnh; [bot](telegram.md) tự báo xong.

## Sửa và trạng thái

- Được yêu cầu sửa: chạy `reopen` với cùng thư mục, sửa kịch bản hoặc ghi lỗi cụ thể với ảnh cần sửa; khóa lại rồi theo handoff. Nội dung/trang và mẫu không đổi giữ nguyên biên bản. Bot không gửi bộ ảnh khi đang sửa.
- `approve` hoặc `publish` chỉ chạy khi người dùng xác nhận đúng thành phẩm đã duyệt hoặc đã đăng. Ghi xác nhận trong notes; hoàn thành không đồng nghĩa đã duyệt hay đăng.
- Lưu kịch bản, nguồn/ghi chú, mẫu đã ghim, ảnh chốt, biên bản và dữ liệu cần phục hồi. Không tạo revision/snapshot kịch bản thứ hai. Không xóa dữ liệu khi API hay chuyển giao chưa rõ; không tự dọn hồ sơ lịch sử. Git không theo dõi dữ liệu tập.
