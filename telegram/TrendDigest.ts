import { TrendItem, TrendTokenMatch } from '../models/types';

export class TrendDigest {

    formatTrendList(trends: TrendItem[]): string {
        if (trends.length === 0) return "📉 No significant social trends detected right now.";

        let msg = `🛰 **SCANDEX TREND RADAR**\n\n`;

        trends.forEach((t, i) => {
            const strength = t.trendScore >= 70 ? 'STRONG' : t.trendScore >= 40 ? 'MEDIUM' : 'WEAK';
            const sources = t.source.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' + ');

            msg += `${i + 1}) **"${t.phrase}"** — ${strength} (${sources})\n`;
            if (t.metrics.twitterTweets) {
                msg += `   • Twitter: ~${(t.metrics.twitterTweets / 1000).toFixed(1)}k tweets\n`;
            }
            msg += `\n`;
        });

        return msg;
    }

    formatTrendTokenMatches(matches: TrendTokenMatch[]): string {
        if (matches.length === 0) return "📉 No trends to analyze.";

        let msg = `🛰 **SCANDEX — TREND → TOKEN SCAN**\n\n`;

        matches.forEach((m, i) => {
            const t = m.trend;
            const strength = t.trendScore >= 70 ? 'STRONG' : 'MEDIUM';

            msg += `${i + 1}) **"${t.phrase}"** — ${strength}\n`;

            if (m.tokens.length > 0) {
                msg += `   • Matching tokens:\n`;
                m.tokens.slice(0, 3).forEach(tok => {
                    const s = tok.snapshot;
                    msg += `     - **$${s.symbol}** — MC $${(s.marketCapUsd || 0 / 1000).toFixed(1)}k, Sc: ${tok.score}/10 ${tok.phase === 'SPOTTED' ? '🛸' : '🔥'}\n`;
                });
            } else {
                msg += `   • _No clear Solana token yet. Watching..._\n`;
            }
            msg += `\n`;
        });

        return msg;
    }
}
