# Kho tập

Mỗi bộ ảnh đăng riêng có mã `Tn` dùng chung trong repo và Telegram. Dữ liệu tập không vào Git.

    T36/
      artifact/
        episode.json     kịch bản và trạng thái duy nhất
        checks/001.json  biên bản kiểm và hash của ảnh
        images/001.jpg   ảnh đã kiểm
      source.txt         nguồn nguyên văn nếu có
      notes.md           ghi chú hoặc xác nhận nếu có
      references/        JSON + ảnh nhân vật đúng phiên bản
      drafts/            hồ sơ lượt vẽ và dữ liệu phục hồi

Theo [quy trình](../docs/workflow.md), không có round hay bản sao kịch bản đang dùng. `T1`–`T35` là tập cũ đã đăng theo xác nhận của người dùng; `T2`–`T34` có bộ ảnh gốc đối chiếu được, còn `T1` và `T35` không có bộ thành phẩm xác minh được. `history/` chỉ là hồ sơ cũ, không dùng để gửi ảnh hoặc chạy lại lệnh. Các sai khác với bộ kiểm tra nguyên văn hiện tại được ghi trong hồ sơ cũ; khi mở tập để làm lại, áp dụng kiểm tra đầy đủ. Tập thử `local-api-e2e-20261111-v1` giữ nguyên, không tính mã và không giao qua bot.
