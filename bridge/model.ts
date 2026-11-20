import type { ContextEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const BOT_MODEL = { provider: '9router', id: 'cx/gpt-6.2-sol', thinking: 'high' } as const;

// Only a deliberate read in the latest tool batch can show image bytes to the model.
export function projectImages(messages: ContextEvent['messages']) {
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  let bytes = 0;
  return messages.map((message, index) => {
    if ((message.role !== 'toolResult' && message.role !== 'user' && message.role !== 'custom') || !Array.isArray(message.content)) return message;
    if (!message.content.some(block => block.type === 'image')) return message;
    const freshRead = lastAssistant >= 0 && index > Math.max(lastAssistant, lastUser)
      && message.role === 'toolResult' && message.toolName === 'read' && !message.isError;
    return { ...message, content: message.content.map(block => {
      if (block.type !== 'image') return block;
      if (freshRead && bytes + block.data.length <= 32 * 1024 * 1024) {
        bytes += block.data.length;
        return block;
      }
      return { type: 'text' as const, text: '[Không kèm ảnh trong ngữ cảnh. Nếu cần xem, dùng read với đúng file/vùng ảnh; không suy đoán nội dung chưa thấy.]' };
    }) };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on('context', event => ({ messages: projectImages(event.messages) }));
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find(BOT_MODEL.provider, BOT_MODEL.id);
    if (!model?.reasoning) throw new Error(`Bot cần model ${BOT_MODEL.id} hỗ trợ suy luận`);
    const ready = await pi.setModel(model);
    if (!ready) throw new Error('Chưa có xác thực cho model của bot');
    pi.setThinkingLevel(BOT_MODEL.thinking);
  });
}
