import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { Narrative, ScoreResult, TokenSnapshot } from '../models/types';
import { DexScreenerService } from '../services/DexScreenerService';

export class ScandexBot {
    private bot: TelegramBot | null = null;

    constructor(
        private dexScreener?: DexScreenerService
    ) {
        if (config.TELEGRAM_BOT_TOKEN) {
            this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });

            // Fix: Start polling only if ENABLED in config to prevent 409 Conflict
            if (config.ENABLE_TELEGRAM_POLLING) {
                this.bot.startPolling().catch(err => {
                    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
                        logger.error('[Telegram] 🚨 409 CONFLICT: Başka bir bot örneği çalışıyor! Lütfen diğer terminali kapatın veya POLLING kapatın.');
                    } else {
                        logger.error(`[Telegram] Polling error: ${err.message}`);
                    }
                });
                logger.info('[Telegram] 📡 Polling STARTED (ENABLE_TELEGRAM_POLLING=true)');
            } else {
                logger.info('[Telegram] 🔕 Polling DISABLED (ENABLE_TELEGRAM_POLLING=false). Bot is in SEND-ONLY mode.');
            }

            this.initCommands();
        } else {
            logger.warn('[Telegram] No Token provided, bot disabled.');
        }
    }

    private initCommands() {
        if (!this.bot) return;

        this.bot.onText(/\/start/, (msg) => {
            this.bot?.sendMessage(msg.chat.id, `🛸 **GEM HUNTER V3.0 ONLINE** 🛸\n\nWatching Base Network for Gem Hunter opportunities.\nChat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/status/, (msg) => {
            if (!this.checkAuth(msg)) return;
            this.bot?.sendMessage(msg.chat.id, `**Gem Hunter V3.0 Status**\nScanning every ${config.SCAN_INTERVAL_SECONDS}s\nNetwork: ${config.NETWORK}`, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/test/, async (msg) => {
            if (!this.checkAuth(msg)) return;
            this.bot?.sendMessage(msg.chat.id, "🧪 **Test Alert**\nTesting connection to channel...", { parse_mode: 'Markdown' });

            try {
                if (config.TELEGRAM_CHAT_ID) {
                    try {
                        await this.bot?.sendMessage(config.TELEGRAM_CHAT_ID, "🚨 **TEST ALERT**\nBot bağlantısı başarılı! 🚀\nGem Hunter V3.0 aktif.", { parse_mode: 'Markdown' });
                        this.bot?.sendMessage(msg.chat.id, `✅ Test message sent to config ID: \`${config.TELEGRAM_CHAT_ID}\``, { parse_mode: 'Markdown' });
                    } catch (e) {
                        if (config.TELEGRAM_ADMIN_IDS.length > 0) {
                            await this.bot?.sendMessage(config.TELEGRAM_ADMIN_IDS[0], "🚨 **TEST ALERT (FALLBACK)**\nKanal ID hatası var.", { parse_mode: 'Markdown' });
                        }
                        throw e;
                    }
                }
            } catch (err: any) {
                this.bot?.sendMessage(msg.chat.id, `❌ Failed to send: ${err.message}`);
            }
        });
    }

    async notifyAdmin(message: string) {
        if (!this.bot || config.TELEGRAM_ADMIN_IDS.length === 0) return;
        for (const adminId of config.TELEGRAM_ADMIN_IDS) {
            try {
                await this.bot.sendMessage(adminId, message, { parse_mode: 'Markdown' });
            } catch (e) {
                logger.error(`[Telegram] Failed to notify admin ${adminId}: ${e}`);
            }
        }
    }

    private isAdmin(userId?: number): boolean {
        if (!userId) return false;
        return config.TELEGRAM_ADMIN_IDS.includes(userId.toString());
    }

    private checkAuth(msg: TelegramBot.Message): boolean {
        const userId = msg.from?.id;
        if (this.isAdmin(userId)) return true;
        this.bot?.sendMessage(msg.chat.id, "⛔ **Yetkisiz Erişim.**", { parse_mode: 'Markdown' });
        return false;
    }

    async sendRawAlert(message: string) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;
        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
            logger.info(`[Telegram] Raw Alert sent`);
        } catch (err: any) {
            logger.error(`[Telegram] Failed to send raw alert: ${err.message}`);
        }
    }

    async sendAlert(narrative: Narrative, token: TokenSnapshot, score: ScoreResult, customTitle?: string) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;
        const titleLine = customTitle ? `🚨 **${customTitle}**` : `🚨 **TOKEN DETECTED: $${token.symbol}**`;
        const message = `📍 **CA:** \`${token.mint}\`
 
${titleLine}
 
${narrative.narrativeText}
 
**Data:**
${narrative.dataSection}
 
**Status:** ${narrative.tradeLens}
**Vibe:** ${narrative.vibeCheck}

[DexScreener](${token.links.dexScreener}) | [Birdeye](${token.links.birdeye || '#'})
 
⚠ _Yatırım Tavsiyesi Değildir._`;

        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            logger.info(`[Telegram] Alert sent for ${token.symbol}`);
        } catch (err: any) {
            logger.error(`[Telegram] Failed to send alert: ${err.message}`);
        }
    }

    async sendDipAlert(data: { symbol: string, mint: string, currentMc: number, dipTargetMc: number }) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;
        const message = `🎯 **DIP ENTRY TRIGGERED** 🎯\n\n**${data.symbol}**\n📍 CA: \`${data.mint}\`\n\n💰 Current MC: $${Math.floor(data.currentMc).toLocaleString()}\n🎯 Target MC: $${data.dipTargetMc.toLocaleString()}\n\n[DexScreener](https://dexscreener.com/base/${data.mint})`;

        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            logger.info(`[Telegram] Dip alert sent for ${data.symbol}`);
        } catch (err: any) {
            logger.error(`[Telegram] Failed to send dip alert: ${err.message}`);
        }
    }

    async stop() {
        if (this.bot) {
            logger.info('[Telegram] Stopping bot polling...');
            await this.bot.stopPolling();
        }
    }
}
