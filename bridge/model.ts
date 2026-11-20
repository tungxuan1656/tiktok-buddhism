import type { ContextEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const BOT_MODEL = { provider: '9router', id: 'cx/gpt-6.2-sol', thinking: 'high' } as const;

// Limit only the model projection; original images and session history remain intact.
export function imageWindow(messages: ContextEvent['messages']) {
  let count = 0;
  let bytes = 0;
  return messages.toReversed().map(message => {
    if ((message.role !== 'toolResult' && message.role !== 'user') || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.toReversed().map(block => {
      if (block.type !== 'image') return block;
      if (count < 8 && bytes + block.data.length <= 32 * 1024 * 1024) {
        count++; bytes += block.data.length;
        return block;
      }
      changed = true;
      return { type: 'text' as const, text: '[Ảnh được lược khỏi ngữ cảnh để tránh request quá lớn; file và lịch sử gốc vẫn còn. Cần xem chi tiết thì đọc lại file/vùng ảnh; không suy đoán nội dung chưa thấy.]' };
    }).reverse();
    return changed ? { ...message, content } : message;
  }).reverse();
}

export default function (pi: ExtensionAPI) {
  pi.on('context', event => ({ messages: imageWindow(event.messages) }));
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find(BOT_MODEL.provider, BOT_MODEL.id);
    if (!model?.reasoning) throw new Error(`Bot cần model ${BOT_MODEL.id} hỗ trợ suy luận`);
    const ready = await pi.setModel(model);
    if (!ready) throw new Error('Chưa có xác thực cho model của bot');
    pi.setThinkingLevel(BOT_MODEL.thinking);
  });
}
