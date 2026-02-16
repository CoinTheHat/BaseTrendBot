import { TokenSnapshot } from '../models/types';
import { FinalScore } from '../core/FinalScorer';

/**
 * PHASE 4: TELEGRAM MESSAGE FORMATTING v6
 * Base Chain adapted from Solana v6 system
 * 
 * Format:
 * [Alert emoji] **[VERDICT]**
 * **TokenName ($SYMBOL)**
 * 📋 CA: `address`
 * 📊 Skor: X/100 | Teknik: Y/40 | Sosyal: Z/60
 * 💰 MC: $Xk | 💧 Liq: $Yk
 * 👥 Holders: X | ⏰ Age: X dk
 * 📖 Hikaye:   ████░ X/5
 * 👥 Topluluk: ███░░ X/5
 * ⚠️ Rug Risk: █░░░░ X/5
 * 💬 AI: [özet]
 * 🚨 Risk: [level]
 * 🔗 DexScreener | Uniswap
 */
export class TelegramNotifier {
    static formatTokenMessage(token: TokenSnapshot, finalScore: FinalScore, aiAnalysis?: any, growth?: number): string {
        const ageMins = token.createdAt ? Math.floor((Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000)) : 0;

        const mc = token.marketCapUsd || 0;
        const liq = token.liquidityUsd || 0;
        const holders = token.holderCount || 0;

        // Alert emoji based on category
        let alertEmoji = "🚨";
        if (finalScore.category === 'APE CANDIDATE') alertEmoji = "🔥";
        else if (finalScore.category === 'EARLY SIGNAL') alertEmoji = "👀";

        // Build message
        let message = `${alertEmoji} **${finalScore.verdict}** ${alertEmoji}\n\n`;
        message += `**${token.name} ($${token.symbol})**\n\n`;

        // Contract Address
        message += `📋 CA: \`${token.mint}\`\n`;

        // Score breakdown
        message += `📊 Skor: ${finalScore.finalScore.toFixed(0)}/100 | Teknik: ${finalScore.technicalScore}/40 | Sosyal: ${finalScore.aiScore}/60\n`;

        // Market Cap and Liquidity
        message += `💰 MC: $${this.formatNumber(mc)} | 💧 Liq: $${this.formatNumber(liq)}\n`;

        // Holders and Age
        let holderLine = `👥 Holders: ${holders}`;
        if (growth && growth >= 1) {
            holderLine += ` (+${growth.toFixed(1)}% in 45min 🔥)`;
        }
        message += holderLine + ` | ⏰ Age: ${ageMins} dk\n`;

        // AI Analysis Bars (if available)
        if (aiAnalysis) {
            // Narrative bar (0-5 mapped to 5 blocks)
            const narrativeMap: Record<string, number> = {
                'strong': 5,
                'medium': 3,
                'weak': 1,
                'none': 0
            };
            const narrativeVal = narrativeMap[aiAnalysis.narrativeStrength] || 0;
            const narrativeBar = this.generateBar(narrativeVal, 5);
            message += `📖 Hikaye:   ${narrativeBar} ${narrativeVal}/5\n`;

            // Community bar (0-5 based on sentiment and tags)
            let communityVal = 0;
            const tags = aiAnalysis.tags || [];
            if (tags.includes("[TECH_ART]") || tags.includes("[ORIGINAL_MEME]") || tags.includes("[SMART_MONEY]")) communityVal += 2;
            if (tags.includes("[REAL_QUESTIONS]")) communityVal += 1;
            if (aiAnalysis.sentiment >= 70) communityVal += 2;
            else if (aiAnalysis.sentiment >= 50) communityVal += 1;
            if (aiAnalysis.influencerCount >= 3) communityVal += 1;
            communityVal = Math.min(5, communityVal);
            const communityBar = this.generateBar(communityVal, 5);
            message += `👥 Topluluk: ${communityBar} ${communityVal}/5\n`;

            // Rug Risk bar (inverted - LOW risk = more filled)
            const riskMap: Record<string, number> = {
                'LOW': 5,
                'MEDIUM': 3,
                'HIGH': 2,
                'DANGEROUS': 1
            };
            const riskVal = riskMap[aiAnalysis.riskLevel] || 2;
            const riskBar = this.generateBar(riskVal, 5);
            message += `⚠️ Rug Risk: ${riskBar} ${aiAnalysis.riskLevel || 'MEDIUM'}\n`;

            // AI Summary
            if (aiAnalysis.summary) {
                message += `\n💬 AI: ${aiAnalysis.summary}\n`;
            }

            // Risk Level
            message += `🚨 Risk: ${aiAnalysis.riskLevel || 'MEDIUM'}\n`;
        }

        // Links
        message += `\n🔗 DexScreener | Uniswap\n`;
        message += `https://dexscreener.com/base/${token.mint}\n`;
        if (token.links.twitter) {
            message += `https://twitter.com/${token.links.twitter.replace('https://twitter.com/', '')}\n`;
        }

        return message;
    }

    /**
     * Generate a visual bar (e.g., "███░░" for 3/5)
     */
    private static generateBar(value: number, max: number): string {
        const filled = "█";
        const empty = "░";
        let bar = "";
        for (let i = 0; i < max; i++) {
            if (i < value) {
                bar += filled;
            } else {
                bar += empty;
            }
        }
        return bar;
    }

    private static formatNumber(num: number): string {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toFixed(0);
    }
}
