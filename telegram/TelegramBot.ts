import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { Narrative, ScoreResult, TokenSnapshot } from '../models/types';
import { MemeWatchlist } from '../core/MemeWatchlist';
import { TrendCollector } from '../trends/TrendCollector';
import { TrendTokenMatcher } from '../core/TrendTokenMatcher';
import { TrendDigest } from './TrendDigest';
import { DexScreenerService } from '../services/DexScreenerService';

export class ScandexBot {
    private bot: TelegramBot | null = null;
    private trendDigest = new TrendDigest();

    constructor(
        private watchlist: MemeWatchlist,
        private trendCollector?: TrendCollector,
        private trendMatcher?: TrendTokenMatcher,
        private dexScreener?: DexScreenerService
    ) {
        if (config.TELEGRAM_BOT_TOKEN) {
            this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
            this.initCommands();
        } else {
            logger.warn('[Telegram] No Token provided, bot disabled.');
        }
    }

    private initCommands() {
        if (!this.bot) return;

        this.bot.onText(/\/start/, (msg) => {
            this.bot?.sendMessage(msg.chat.id, `🛸 **SCANDEX ONLINE** 🛸\n\nWatching Solana for memetic anomalies.\nChat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
        });

        // Current Trends
        this.bot.onText(/\/trends$/, async (msg) => {
            if (!this.trendCollector) return;
            await this.bot?.sendChatAction(msg.chat.id, 'typing');
            const trends = await this.trendCollector.refresh();
            const text = this.trendDigest.formatTrendList(trends);
            this.bot?.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
        });

        // Trend -> Tokens (Alpha)
        this.bot.onText(/\/trendtokens|\/alpha/, async (msg) => {
            if (!this.trendCollector || !this.trendMatcher || !this.dexScreener) {
                this.bot?.sendMessage(msg.chat.id, "❌ Trend modules not enabled.");
                return;
            }
            await this.bot?.sendChatAction(msg.chat.id, 'typing');

            // 1. Get Trends
            const trends = this.trendCollector.getTopTrends(5);

            // 2. Get Recent Tokens (Fresh Scan)
            const tokens = await this.dexScreener.getLatestPairs();

            // 3. Match
            const matches = this.trendMatcher.matchTrends(trends, tokens);

            // 4. Send
            const text = this.trendDigest.formatTrendTokenMatches(matches);
            this.bot?.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/status/, (msg) => {
            if (!this.isAdmin(msg.from?.id)) return;
            this.bot?.sendMessage(msg.chat.id, `**System Status**\nScanning every ${config.SCAN_INTERVAL_SECONDS}s\nNetwork: ${config.NETWORK}`, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/test/, async (msg) => {
            if (!this.isAdmin(msg.from?.id)) return;
            this.bot?.sendMessage(msg.chat.id, "🧪 **Test Alert**\nTesting connection to channel...", { parse_mode: 'Markdown' });

            // Simulate a fake alert to the Main Channel
            try {
                if (config.TELEGRAM_CHAT_ID) {
                    try {
                        await this.bot?.sendMessage(config.TELEGRAM_CHAT_ID, "🚨 **TEST ALERT**\nBot bağlantısı başarılı! 🚀\nBu mesaj Railway üzerinden geldiyse sistem çalışıyor demektir.", { parse_mode: 'Markdown' });
                        this.bot?.sendMessage(msg.chat.id, `✅ Test message sent to config ID: \`${config.TELEGRAM_CHAT_ID}\``, { parse_mode: 'Markdown' });
                    } catch (e) {
                        // Fallback to Admin
                        if (config.TELEGRAM_ADMIN_ID) {
                            await this.bot?.sendMessage(config.TELEGRAM_ADMIN_ID, "🚨 **TEST ALERT (FALLBACK)**\nKanal ID hatası var, bu mesaj Admin ID'ye (Sana) gönderildi.", { parse_mode: 'Markdown' });
                            this.bot?.sendMessage(msg.chat.id, `⚠️ Failed to send to Channel, but sent to Admin ID. Check Bot permissions in Channel.`);
                        }
                        throw e;
                    }
                } else {
                    this.bot?.sendMessage(msg.chat.id, "❌ TELEGRAM_CHAT_ID not set.");
                }
            } catch (err: any) {
                this.bot?.sendMessage(msg.chat.id, `❌ Failed to send to \`${config.TELEGRAM_CHAT_ID}\`:\n${err.message || err}`);
            }
        });

        this.bot.onText(/\/watchlist/, (msg) => {
            if (!this.isAdmin(msg.from?.id)) return;
            const items = this.watchlist.getWatchlist();
            if (items.length === 0) {
                this.bot?.sendMessage(msg.chat.id, "📭 Watchlist is empty.");
                return;
            }
            const text = items.map((item, idx) => `${idx + 1}. **${item.phrase}** ${item.tags.length ? `(tags: ${item.tags.join(', ')})` : ''}`).join('\n');
            this.bot?.sendMessage(msg.chat.id, `📋 **Meme Watchlist** (${items.length}):\n\n${text}`, { parse_mode: 'Markdown' });
        });

        // Add: /add <phrase> [tags]
        this.bot.onText(/\/add (.+)/, async (msg, match) => {
            if (!this.isAdmin(msg.from?.id)) return;
            const raw = match?.[1] || "";
            // Format: phrase | tag1, tag2
            const [phrasePart, tagsPart] = raw.split('|');
            const phrase = phrasePart.trim();
            if (!phrase) return;

            const tags = tagsPart ? tagsPart.split(',').map(t => t.trim()) : [];

            const newItem = await this.watchlist.addPhrase(phrase, tags);
            this.bot?.sendMessage(msg.chat.id, `✅ Added to watchlist: **"${newItem.phrase}"**`, { parse_mode: 'Markdown' });
        });

        // Remove: /remove <phrase>
        this.bot.onText(/\/remove (.+)/, async (msg, match) => {
            if (!this.isAdmin(msg.from?.id)) return;
            const phrase = match?.[1]?.trim().toLowerCase();
            if (!phrase) return;

            const removed = await this.watchlist.removePhrase(phrase);
            if (removed) {
                this.bot?.sendMessage(msg.chat.id, `🗑 Removed from watchlist: **"${phrase}"**`, { parse_mode: 'Markdown' });
            } else {
                this.bot?.sendMessage(msg.chat.id, `❌ Phrase **"${phrase}"** not found.`, { parse_mode: 'Markdown' });
            }
        });
    }

    private isAdmin(userId?: number): boolean {
        if (!userId) return false;
        return userId.toString() === config.TELEGRAM_ADMIN_ID;
    }

    async sendAlert(narrative: Narrative, token: TokenSnapshot, score: ScoreResult) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;

        const isTrendLinked = !!narrative.twitterStory;
        const phaseEmoji = score.phase === 'SPOTTED' ? '🛸' : score.phase === 'COOKING' ? '🔥' : score.phase === 'TRACKING' ? '📡' : '🍽';

        let titleLine = `${phaseEmoji} **SCANDEX MEME RADAR — ${score.phase}**`;

        // Breaking News Override
        if (isTrendLinked) {
            titleLine = `🚨 **SON DAKİKA — TREND TESPİT EDİLDİ** 🚨`;
        }

        // Add Risk Warning to top if DANGEROUS
        if (narrative.twitterStory?.riskAnalysis?.level === 'DANGEROUS') {
            titleLine = `⛔ **SCANDEX WARNING — HIGH RISK DETECTED** ⛔\n${titleLine}`;
        }

        const message =
            `${titleLine}

**Narrative:**
${narrative.narrativeText}

**Data:**
${narrative.dataSection}

**Phase:** ${score.phase}
**Vibe:** ${narrative.vibeCheck}
**Score:** ${score.totalScore}/10

${narrative.twitterStory ? `🔍 **DEDEKTİF ANALİZİ (Vibe Check)**
Güven Skoru: **${narrative.twitterStory.trustScore ?? 50}/100** (${(narrative.twitterStory.trustScore ?? 50) >= 75 ? 'Güvenli ✅' : (narrative.twitterStory.trustScore ?? 50) < 40 ? 'Riskli 🔴' : 'Orta 🟡'})
Twitter Havası: _"${narrative.twitterStory.riskAnalysis?.flags?.length ? '⚠️ ' + narrative.twitterStory.riskAnalysis.flags.join(', ') + ' tespit edildi.' : 'Temiz görünüyor.'}"_

**Analiz Detayları:**
${narrative.twitterStory.summary}

**Örnek Tweet:**
${narrative.twitterStory.sampleLines[0] || 'Veri yok'}` : ''}

[DexScreener](${token.links.dexScreener}) | [Pump.fun](${token.links.pumpfun}) | [Birdeye](${token.links.birdeye || '#'})

⚠ _Yatırım Tavsiyesi Değildir._`;

        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            logger.info(`[Telegram] Alert sent for ${token.symbol}`);
        } catch (err) {
            logger.error(`[Telegram] Failed to send alert: ${err} `);
        }
    }
}
