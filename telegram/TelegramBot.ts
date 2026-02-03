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
            this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });

            // Fix: Start polling manually to catch 409 Conflict
            this.bot.startPolling().catch(err => {
                if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
                    logger.error('[Telegram] 🚨 409 CONFLICT: Başka bir bot örneği çalışıyor! Lütfen diğer terminali kapatın.');
                } else {
                    logger.error(`[Telegram] Polling error: ${err.message}`);
                }
            });

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
            if (!this.checkAuth(msg)) return; // Guard
            if (!this.trendCollector) return;
            await this.bot?.sendChatAction(msg.chat.id, 'typing');
            const trends = await this.trendCollector.refresh();
            const text = this.trendDigest.formatTrendList(trends);
            this.bot?.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
        });

        // Trend -> Tokens (Alpha)
        this.bot.onText(/\/trendtokens|\/alpha/, async (msg) => {
            if (!this.checkAuth(msg)) return; // Guard
            if (!this.trendCollector || !this.trendMatcher || !this.dexScreener) {
                this.bot?.sendMessage(msg.chat.id, "❌ Trend modules not enabled.");
                return;
            }
            await this.bot?.sendChatAction(msg.chat.id, 'typing');
            this.bot?.sendMessage(msg.chat.id, "🕵️‍♂️ **Derin Tarama Başlatıldı...**\nHer trend için canlı havuz taranıyor. (Bu işlem 10-15s sürebilir)");

            // 1. Get Top Trends
            const trends = this.trendCollector.getTopTrends(5);
            let matches: any[] = [];

            // 2. Targeted Search (The Fix)
            // Instead of relying on a generic 'latest' list, we search specifically for each trend.
            for (const trend of trends) {
                // Search DexScreener for this trend phrase
                const results = await this.dexScreener.search(trend.phrase);

                // If found, add to matches (Reuse matcher logic or manual format)
                if (results.length > 0) {
                    // Pick best result (highest liquidity or exact match)
                    const best = results.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))[0];
                    matches.push({
                        trend: trend,
                        tokens: [{ snapshot: best, score: 99 }]
                    });
                }
                // Else: Do not push empty match (Hide "Watching..." clutter)
            }

            // 4. Send Result (Filtered)
            if (matches.length === 0) {
                this.bot?.sendMessage(msg.chat.id, "📉 **Şu an Twitter trendlerine uyan bir Solana tokenı bulunamadı.**\nSistem taramaya devam ediyor...");
                return;
            }

            const text = this.trendDigest.formatTrendTokenMatches(matches);
            this.bot?.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
        });

        this.bot.onText(/\/status/, (msg) => {
            if (!this.checkAuth(msg)) return; // Guard
            this.bot?.sendMessage(msg.chat.id, `**System Status**\nScanning every ${config.SCAN_INTERVAL_SECONDS}s\nNetwork: ${config.NETWORK}`, { parse_mode: 'Markdown' });
        });

        this.bot.onText(/\/test/, async (msg) => {
            if (!this.checkAuth(msg)) return; // Guard
            this.bot?.sendMessage(msg.chat.id, "🧪 **Test Alert**\nTesting connection to channel...", { parse_mode: 'Markdown' });

            // Simulate a fake alert to the Main Channel
            try {
                if (config.TELEGRAM_CHAT_ID) {
                    try {
                        await this.bot?.sendMessage(config.TELEGRAM_CHAT_ID, "🚨 **TEST ALERT**\nBot bağlantısı başarılı! 🚀\nBu mesaj Railway üzerinden geldiyse sistem çalışıyor demektir.", { parse_mode: 'Markdown' });
                        this.bot?.sendMessage(msg.chat.id, `✅ Test message sent to config ID: \`${config.TELEGRAM_CHAT_ID}\``, { parse_mode: 'Markdown' });
                    } catch (e) {
                        // Fallback to Admin
                        if (config.TELEGRAM_ADMIN_IDS.length > 0) {
                            await this.bot?.sendMessage(config.TELEGRAM_ADMIN_IDS[0], "🚨 **TEST ALERT (FALLBACK)**\nKanal ID hatası var, bu mesaj ilk Admin ID'ye (Sana) gönderildi.", { parse_mode: 'Markdown' });
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
            if (!this.checkAuth(msg)) return; // Guard
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
            if (!this.checkAuth(msg)) return; // Guard
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
            if (!this.checkAuth(msg)) return; // Guard
            const phrase = match?.[1]?.trim(); // Keep Case!
            if (!phrase) return;

            const removed = await this.watchlist.removePhrase(phrase);
            if (removed) {
                this.bot?.sendMessage(msg.chat.id, `🗑 Removed from watchlist: **"${phrase}"**`, { parse_mode: 'Markdown' });
            } else {
                this.bot?.sendMessage(msg.chat.id, `❌ Phrase **"${phrase}"** not found.`, { parse_mode: 'Markdown' });
            }
        });
        // Analyze: /analyze <token_address>
        this.bot.onText(/\/analyze (.+)/, async (msg, match) => {
            if (!this.checkAuth(msg)) return; // Guard
            const ca = match?.[1]?.trim();
            if (!ca) return;

            this.bot?.sendMessage(msg.chat.id, `🔍 **Analiz Başlatılıyor...**\nCA: \`${ca}\`\n\n_Twitter verileri taranıyor, lütfen bekleyin (10-20sn)..._`, { parse_mode: 'Markdown' });

            // Trigger manual analysis (This requires exposing a method in TokenScanJob or similar, or just running ad-hoc logic here)
            // For now, let's try to fetch token info via DexScreener/Birdeye then run Story Engine
            try {
                // 1. Fetch info
                let token: TokenSnapshot | null = null;
                const pairs = await this.dexScreener?.getLatestPairs(); // Optimized: usually better to fetch specific, but DexApi might not have getOne.
                // Fallback: Create dummy snapshot if needed, or implement getOne. 
                // Let's assume we can use Birdeye for specific lookup if Dex fails or iterate.
                // ...Simpler: Use Birdeye to get basics
                if (this.dexScreener) {
                    // Try to find in cache or recent? 
                    // Actually, let's just use what we have available. 
                    // Note: Ideally we'd have a `services.getToken(ca)` method.
                }

                // Temporary: Just tell user to watch Logs for now if complexity is high, 
                // OR implement a quick scraper check.

                // Let's rely on the "Watchlist" mechanism. If they Add it, it gets scanned.
                // Suggestion: Just use /add, but this command confirms "I am looking".
                this.bot?.sendMessage(msg.chat.id, `⚠️ **Hızlı Analiz** modülü henüz aktif değil. Lütfen \`/add ${ca}\` komutunu kullanarak Watchlist'e ekleyin. Bot otomatik olarak tarayıp raporlayacaktır.`, { parse_mode: 'Markdown' });

            } catch (e) {
                this.bot?.sendMessage(msg.chat.id, `❌ Hata: ${e}`);
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

    /**
     * Middleware-like guard.
     * Returns true if authorized, false (and sends rejection) if not.
     */
    private checkAuth(msg: TelegramBot.Message): boolean {
        const userId = msg.from?.id;
        if (this.isAdmin(userId)) return true;

        // Unauthorized
        this.bot?.sendMessage(msg.chat.id, "⛔ **Yetkisiz Erişim:** Bu bot özeldir, komutlarınız reddedildi.", { parse_mode: 'Markdown' });
        logger.warn(`[Security] Unauthorized access attempt from User ${userId} (${msg.from?.username || 'NoUser'}) in Chat ${msg.chat.id}`);
        return false;
    }

    async sendTokenAlert(token: TokenSnapshot, narrative: Narrative, customTitle?: string) {
        return this.sendAlert(narrative, token, { totalScore: 0, breakdown: [], phase: 'SPOTTED' }, customTitle);
    }

    async sendAlert(narrative: Narrative, token: TokenSnapshot, score: ScoreResult, customTitle?: string) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;

        const isTrendLinked = !!narrative.twitterStory;

        let titleLine = customTitle ? `🚨 **${customTitle}**` : `🚨 **TOKEN DETECTED: $${token.symbol}**`;

        // Breaking News Override (Viral/Trend)
        if (isTrendLinked && !customTitle) {
            titleLine = `📈 **TREND ALERT: $${token.symbol}**`;
        }

        // Early Alpha Override
        if (narrative.twitterStory?.potentialCategory === 'EARLY_ALPHA') {
            titleLine = `⚡ **EARLY MOVER: $${token.symbol}**`;
        } else if (narrative.twitterStory?.potentialCategory === 'SUPER_ALPHA') {
            titleLine = `🚀 **HIGH VELOCITY: $${token.symbol}**`;
        }

        // Add Risk Warning to top if DANGEROUS including specific flags
        if (narrative.twitterStory?.riskAnalysis?.level === 'DANGEROUS') {
            titleLine = `⛔ **RISK WARNING: $${token.symbol}** ⛔\n${titleLine}`;
        }

        let message =
            `📍 **CA:** \`${token.mint}\`

${titleLine}

${narrative.narrativeText}

**Data:**
${narrative.dataSection}

**Status:** ${narrative.tradeLens}
**Vibe:** ${narrative.vibeCheck}`;

        if (narrative.twitterStory) {
            message += `\n\n🔍 **DEDEKTİF ANALİZİ (Vibe Check)**
Güven Skoru: **${narrative.twitterStory.trustScore ?? 50}/100** (${(narrative.twitterStory.trustScore ?? 50) >= 75 ? 'Güvenli ✅' : (narrative.twitterStory.trustScore ?? 50) < 40 ? 'Riskli 🔴' : 'Orta 🟡'})`;
            message += `\n🐦 **Twitter Havası:** ${narrative.twitterStory.riskAnalysis?.level === 'SAFE' ? 'Temiz ☀️' : 'Karışık 🌪️'}`;
            message += `\n📝 **Analiz Detayları:**\n${narrative.twitterStory.summary}`;

            if (narrative.twitterStory.sampleLines.length > 0) {
                message += `\n\n💬 **Örnek Tweet:**\n${narrative.twitterStory.sampleLines[0]}`;
            }
        }

        // Technical Security Seals
        if (token.mintAuthority) {
            message += `\n\n⚠️ **MINT IS OPEN (Yeni coin basılabilir!)**`;
        }
        if (token.top10HoldersSupply && token.top10HoldersSupply > 50) {
            message += `\n🔴 **CENTRALIZED SUPPLY (Top 10 > %${token.top10HoldersSupply.toFixed(1)})**`;
        }

        message += `\n\n[DexScreener](${token.links.dexScreener}) | [Pump.fun](${token.links.pumpfun}) | [Birdeye](${token.links.birdeye || '#'})

⚠ _Yatırım Tavsiyesi Değildir._`;

        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            logger.info(`[Telegram] Alert sent for ${token.symbol}`);
        } catch (err) {
            logger.error(`[Telegram] Failed to send alert: ${err} `);
        }
    }

    async sendDipAlert(token: { symbol: string; mint: string; currentMc: number; dipTargetMc: number }) {
        if (!this.bot || !config.TELEGRAM_CHAT_ID) return;

        const message = `📉 **CORRECTION ENTRY DETECTED** 📉
**$${token.symbol}**
        
Correction target hit! Price pulled back from 5m pump.

**Target MC:** $${Math.floor(token.dipTargetMc).toLocaleString()}
**Current MC:** $${Math.floor(token.currentMc).toLocaleString()}
**CA:** \`${token.mint}\`

[DexScreener](https://dexscreener.com/solana/${token.mint})

⚠️ _This entry is based on a momentum pullback strategy._`;

        try {
            await this.bot.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
            logger.info(`[Telegram] Dip Alert sent for ${token.symbol}`);
        } catch (err) {
            logger.error(`[Telegram] Failed to send Dip Alert: ${err}`);
        }
    }

    async stop() {
        if (this.bot) {
            logger.info('[Telegram] Stopping bot polling...');
            await this.bot.stopPolling();
        }
    }
}
