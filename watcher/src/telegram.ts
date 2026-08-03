import { isAddress, getAddress } from 'viem';
import type { PublicClient } from 'viem';
import { loadPortfolio, renderPortfolio } from './portfolio.js';
import type { Alert } from './alerts.js';

/**
 * Minimal Telegram Bot API client over long polling.
 *
 * Deliberately dependency-free: the bot is read-only and public, so its whole attack surface
 * is "someone sends us a string". Fewer dependencies is fewer places for that to go wrong.
 */

const API = 'https://api.telegram.org';

export interface TelegramConfig {
  token: string;
  /** Addresses users have opted into watching, keyed by chat id. No keys are ever stored. */
  subscriptions: Map<number, Set<string>>;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

export class TelegramBot {
  private offset = 0;
  private running = false;

  constructor(
    private readonly cfg: TelegramConfig,
    private readonly client: PublicClient,
  ) {}

  private async call<T>(method: string, body: unknown): Promise<T | undefined> {
    try {
      const res = await fetch(`${API}/bot${this.cfg.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(65_000),
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) console.error(`telegram ${method} failed: ${json.description}`);
      return json.result;
    } catch (e) {
      console.error(`telegram ${method} error: ${(e as Error).message}`);
      return undefined;
    }
  }

  async send(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  /** Push an alert to every chat watching the alert's subject. */
  async broadcast(alert: Alert): Promise<void> {
    const icon = alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
    const text = `${icon} <b>${alert.kind.replace(/_/g, ' ')}</b>\n\n${alert.message}`;
    for (const [chatId, watched] of this.cfg.subscriptions) {
      if (watched.has(alert.subject.toLowerCase())) await this.send(chatId, text);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('telegram bot polling...');
    while (this.running) {
      const updates = await this.call<Update[]>('getUpdates', {
        offset: this.offset,
        timeout: 50,
      });
      for (const u of updates ?? []) {
        this.offset = u.update_id + 1;
        if (u.message?.text) {
          await this.handle(u.message.chat.id, u.message.text.trim()).catch((e) =>
            console.error(`handler error: ${(e as Error).message}`),
          );
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async handle(chatId: number, text: string): Promise<void> {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = (cmdRaw ?? '').toLowerCase();

    if (cmd === '/start' || cmd === '/help') {
      return this.send(chatId, HELP);
    }

    if (cmd === '/watch' || cmd === '/unwatch') {
      const addr = rest[0];
      if (!addr || !isAddress(addr)) {
        return this.send(chatId, `Send a valid address, e.g.\n<code>${cmd} 0x1234…</code>`);
      }
      const key = getAddress(addr).toLowerCase();
      const set = this.cfg.subscriptions.get(chatId) ?? new Set<string>();
      if (cmd === '/watch') {
        set.add(key);
        this.cfg.subscriptions.set(chatId, set);
        return this.send(
          chatId,
          `Watching <code>${getAddress(addr)}</code>.\n\nYou will be alerted if a validator ` +
            `goes inactive, raises commission, stops producing for 24h, or if an unexpected ` +
            `unstake appears.\n\nThis stores only the address. MonRescue never asks for a ` +
            `seed phrase or private key.`,
        );
      }
      set.delete(key);
      return this.send(chatId, `Stopped watching <code>${getAddress(addr)}</code>.`);
    }

    if (cmd === '/list') {
      const set = this.cfg.subscriptions.get(chatId);
      if (!set || set.size === 0) return this.send(chatId, 'You are not watching any addresses.');
      return this.send(
        chatId,
        `Watching:\n${[...set].map((a) => `<code>${getAddress(a)}</code>`).join('\n')}`,
      );
    }

    // Bare address -> portfolio lookup. This is the primary interaction.
    const candidate = cmd.startsWith('/') ? rest[0] : cmdRaw;
    if (candidate && isAddress(candidate)) {
      await this.send(chatId, 'Looking up delegations…');
      const portfolio = await loadPortfolio(this.client, getAddress(candidate));
      return this.send(chatId, renderPortfolio(portfolio));
    }

    return this.send(chatId, HELP);
  }
}

const HELP = `<b>MonRescue</b> — Monad delegator alerts

Send a wallet address to see its delegations, rewards, and validator health.

<b>Commands</b>
<code>/watch 0x…</code> — get alerted about that address
<code>/unwatch 0x…</code> — stop alerts
<code>/list</code> — addresses you watch

<b>Alerts</b>
• validator goes inactive
• validator raises commission
• validator produces nothing for 24h+
• unexpected unstake on a watched address

Read-only and public. MonRescue will <b>never</b> ask for your seed phrase or private key — anyone who does is trying to rob you.`;
