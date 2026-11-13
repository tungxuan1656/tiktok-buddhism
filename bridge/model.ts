import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const BOT_MODEL = { provider: '9router', id: 'cx/gpt-6.1-sol', thinking: 'xhigh' } as const;

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find(BOT_MODEL.provider, BOT_MODEL.id);
    if (!model?.reasoning) throw new Error('Bot cần model cx/gpt-6.1-sol hỗ trợ suy luận');
    // The proxy alias omits xhigh; change only this session's metadata, not provider/auth/global defaults.
    const ready = await pi.setModel({ ...model, thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: 'xhigh' } });
    if (!ready) throw new Error('Chưa có xác thực cho model của bot');
    pi.setThinkingLevel(BOT_MODEL.thinking);
  });
}
