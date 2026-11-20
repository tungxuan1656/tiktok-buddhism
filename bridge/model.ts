import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const BOT_MODEL = { provider: '9router', id: 'cx/gpt-6.2-sol', thinking: 'high' } as const;

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find(BOT_MODEL.provider, BOT_MODEL.id);
    if (!model?.reasoning) throw new Error(`Bot cần model ${BOT_MODEL.id} hỗ trợ suy luận`);
    const ready = await pi.setModel(model);
    if (!ready) throw new Error('Chưa có xác thực cho model của bot');
    pi.setThinkingLevel(BOT_MODEL.thinking);
  });
}
