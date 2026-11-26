import { join } from 'node:path';
import { normalizeObjectsValue } from './fingerprint.mjs';
import { DEFAULT_STYLE_REL, MAX_REFS, REPO_ROOT } from './policy.mjs';

function formatCharDesc(loaded) {
  const id = loaded.data.identity ?? {};
  const parts = [id.face, id.hair, id.body, id.clothing].filter(Boolean).join('; ');
  const keep = Array.isArray(loaded.data.keep) && loaded.data.keep.length ? ` Giữ: ${loaded.data.keep.join('; ')}.` : '';
  const avoid = Array.isArray(loaded.data.avoid) && loaded.data.avoid.length ? ` Tránh: ${loaded.data.avoid.join('; ')}.` : '';
  return `${loaded.id}/${loaded.version} (${parts}${keep}${avoid})`;
}

export function slidePrompt(dir, episode, validation, slide, correction) {
  const s = episode.slides[slide - 1];
  const resolvedChars = validation.resolvedCharsBySlide[slide - 1];
  const resolvedStyleRef = validation.styleReference?.path ?? join(REPO_ROOT, DEFAULT_STYLE_REL);
  const refs = [resolvedStyleRef];
  const refLabels = ['1. Ảnh phong cách (chỉ tham chiếu nét chì, kiểu chữ, nền giấy và khoảng trắng; không chép chữ/người/vật)'];
  const charDescs = [];

  for (const loaded of resolvedChars) {
    charDescs.push(formatCharDesc(loaded));
    for (let idx = 0; idx < loaded.refPaths.length; idx++) {
      refs.push(join(dir, loaded.refPaths[idx]));
      refLabels.push(`${refs.length}. Định danh ${loaded.id}/${loaded.version} (giữ khuôn mặt, tóc, vóc dáng, y phục; không chép tư thế/nền mẫu)`);
    }
  }
  if (refs.length > MAX_REFS) throw new Error(`Slide ${slide}: ${refs.length} reference images exceed API maximum of ${MAX_REFS}`);

  const symbolic = s.scene_type === 'simile' || s.scene_type === 'concept'
    ? ' Hình biểu trưng, không dựng thành sự kiện lịch sử.' : '';
  const allowedObjects = normalizeObjectsValue(s.objects);
  const allowedObjectsText = Array.isArray(allowedObjects) ? allowedObjects.join(', ') : allowedObjects;
  const objectLine = allowedObjectsText
    ? `Vật thể được phép: ${allowedObjectsText}. Không thêm người, vật thể, hào quang hay hiệu ứng ngoài danh sách.`
    : 'Không thêm người, vật thể, hào quang hay hiệu ứng ngoài cảnh yêu cầu.';
  const tyWithGrave = s.text.normalize('NFC').match(/(?<![\p{L}\p{M}\p{N}])tỳ(?![\p{L}\p{M}\p{N}])/iu)?.[0];
  const content = [
    'Tạo 1 slide minh họa Phật giáo 2D hoàn chỉnh (khung dọc 3:4, mục tiêu 1080 × 1440), có đúng đoạn chữ tiếng Việt bên dưới.',
    '- Phong cách: nét chì màu mảnh, vàng đất/nâu dịu; nền giấy gần trắng, sáng trung tính, không phủ kem/vàng; 1 cụm minh họa gọn, ít chi tiết, nhiều khoảng trắng; biểu cảm trang nghiêm, hiền hòa. Không ảnh chụp, 3D, anime, khung, bong bóng thoại, logo, watermark hay chữ trang trí.',
    '- Bố cục & chữ: bố cục linh hoạt, tranh và chữ đầy đủ, rõ ràng, không che nhau/cắt mép; không thu nhỏ chữ để ép khung. Dùng chữ KHÔNG CHÂN, nét tròn mềm, đều nét, hơi giống chữ viết tay, rõ dấu tiếng Việt, cỡ tương đương 44–52 px khi xuất, màu nâu sẫm #4B2F1E, canh giữa, lề thoáng. Không dùng serif, chữ sách cổ hoặc nét đậm nặng.',
    '',
    'Chỉ dẫn về chữ (không in): Giữ cả dấu tạo chữ và dấu thanh, đặt đúng vị trí trên hoặc dưới đúng chữ cái. Chép đúng từng dấu câu, kể cả dấu ngoặc kép mở và đóng nếu có. Ảnh mẫu và mô tả cảnh không phải nguồn chữ.',
    ...(tyWithGrave ? [`Lưu ý dấu huyền (không in dòng này): Ở mọi chỗ có chữ ${tyWithGrave}, dấu huyền nằm trên y, là một nét xiên từ trên trái xuống dưới phải, không có móc. Giữ nguyên hoa/thường và dấu của từng chữ theo văn bản.`] : []),
    'CHỮ CẦN IN — chỉ in nguyên văn phần giữa hai dòng phân cách (không in dòng phân cách/nhãn, không sửa/thêm/bớt từ hay dấu, không thêm ngoặc kép/tiêu đề/số trang/chú thích):',
    '--- BẮT ĐẦU VĂN BẢN ---',
    s.text,
    '--- KẾT THÚC VĂN BẢN ---',
    '',
    'Ảnh tham chiếu gửi kèm (theo đúng thứ tự, tối đa 10 ảnh):',
    ...refLabels,
    '',
    `Loại cảnh: ${s.scene_type}.${symbolic}`,
    `Cảnh: ${s.scene}`,
    `Nhân vật: ${charDescs.length ? charDescs.join('; ') : 'không có'}.`,
    objectLine,
    ...(correction ? ['', `Sửa lỗi ở lượt trước: ${correction}`] : []),
    '',
  ].join('\n');

  return { prompt: content, references: refs };
}
