import { Env, BroadcastMessage } from './types';
import { handleTelegramWebhook } from './bot-logic';
import { handleApironeCallback } from './apirone-logic';
import { TelegramClient } from './telegram-client';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      ctx.waitUntil(handleTelegramWebhook(await request.json(), env)); 
      return new Response('OK');
    }

    if (request.method === 'POST' && url.pathname === '/webhook/apirone') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      ctx.waitUntil(handleApironeCallback(await request.json(), env));
      return new Response('*ok*', { headers: { 'Content-Type': 'text/plain' }});
    }

    if (url.pathname === '/init') {
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${env.WEBHOOK_URL}/webhook/telegram`, secret_token: env.WEBHOOK_SECRET })
      });
      return new Response(await resp.text());
    }

    return new Response('Visatk Premium Gateway Active.', { status: 200 });
  },

  // NEW: Background Queue Consumer for Broadcasts
  async queue(batch: MessageBatch<BroadcastMessage>, env: Env): Promise<void> {
    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    for (const message of batch.messages) {
      try {
        await tg.sendMessage(message.body.userId, message.body.text, undefined, true);
        message.ack(); // Mark as successful
      } catch (e) {
        // Ignore blocks from deactivated users to keep queue moving
        message.ack();
      }
    }
  }
};
