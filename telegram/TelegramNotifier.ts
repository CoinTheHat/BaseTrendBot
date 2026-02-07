import { TokenSnapshot } from '../models/types';
import { FinalScore } from '../core/FinalScorer';

/**
 * PHASE 4: TELEGRAM MESSAGE FORMATTING
 */
export class TelegramNotifier {
    static formatTokenMessage(token: TokenSnapshot, finalScore: FinalScore, aiAnalysis?: any, growth?: number): string {
        const ageMins = token.createdAt ? Math.floor((Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000)) : 0;

        const mc = token.marketCapUsd || 0;
        const liq = token.liquidityUsd || 0;
        const holders = token.holderCount || 0;
        const top10 = token.top10HoldersSupply || 0;
        const lpLock = token.lpLockedPercent || 0;

        let message = `🚨 **${finalScore.verdict}** 🚨\n\n`;
        message += `**${token.name} ($${token.symbol})**\n\n`;
        message += `📊 **Final Score:** ${finalScore.finalScore.toFixed(0)}/100\n`;
        message += `├─ Technical: ${finalScore.technicalScore.toFixed(0)}/50\n`;
        message += `└─ AI Social: ${finalScore.aiScore.toFixed(0)}/50\n`;

        if (finalScore.bonuses > 0) message += `   └─ Bonuses: +${finalScore.bonuses.toFixed(0)}\n`;
        if (finalScore.penalties > 0) message += `   └─ Penalties: -${finalScore.penalties.toFixed(0)}\n`;

        message += `\n💰 **Market Cap:** $${this.formatNumber(mc)}\n`;
        message += `💧 **Liquidity:** $${this.formatNumber(liq)} (${lpLock.toFixed(0)}% locked)\n`;

        let holderLine = `👥 **Holders:** ${holders}`;
        // Note: Real growth tracking requires history, but if we have it in the snapshots or via maturation:
        // We'll add it if maturation data exists
        if (growth && growth >= 1) {
            holderLine += ` (+${growth.toFixed(1)}% in 45min 🔥)`;
        }
        message += holderLine + `\n`;

        message += `🐋 **Top 10:** ${top10.toFixed(1)}%\n`;
        message += `⏰ **Age:** ${ageMins} mins\n\n`;

        if (aiAnalysis) {
            message += `🤖 **AI Summary:**\n${aiAnalysis.summary}\n\n`;
            message += `📊 **Sentiment:** ${aiAnalysis.sentiment}% Bullish\n`;
            message += `📝 **Narrative:** ${(aiAnalysis.narrativeStrength || '').toUpperCase()}\n`;
            message += `⭐ **Influencers:** ${aiAnalysis.influencerCount}\n`;
            message += `🚨 **Risk:** ${aiAnalysis.riskLevel}\n\n`;
        }

        message += `🔗 **Links:**\n`;
        message += `DexScreener: https://dexscreener.com/base/${token.mint}\n`;
        if (token.links.twitter) message += `Twitter: ${token.links.twitter}\n`;

        return message;
    }

    private static formatNumber(num: number): string {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toFixed(0);
    }
}
