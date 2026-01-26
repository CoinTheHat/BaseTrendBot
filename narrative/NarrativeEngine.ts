import { TokenSnapshot, MemeWatchItem, ScoreResult, Narrative } from '../models/types';
import { MemeMatchResult } from '../models/types';

export class NarrativeEngine {

    generate(token: TokenSnapshot, match: MemeMatchResult, score: ScoreResult): Narrative {
        let memeName = match.matchedMeme ? match.matchedMeme.phrase : 'unknown';
        const symbol = token.symbol;

        // Visual Fit: If memeName is a CA (long), use Token Name instead
        if (memeName.length > 15 && !memeName.includes(' ')) {
            memeName = `${token.name} (${symbol})`;
        }

        // 1. Narrative Context
        // Dynamic "Why": Distinguish between Watchlist, Trend, and Alpha
        let intro = `The '${memeName}' meme is trending off-chain.`;
        if (match.matchedMeme?.tags?.includes('ALPHA')) {
            intro = `High momentum detected for **$${symbol}**.`;
        } else if (match.matchedMeme?.phrase === token.mint) {
            intro = `**$${symbol}** detected via Watchlist (Specific CA match).`;
        }

        const narrativeText = `${intro} First Solana token aligned with this vibe just spawned: **$${symbol}**.\n\n` +
            `Alien sensors detected specific high-frequency alignment with human distress signals around this meme.`;

        // 2. Data Section
        const dataSection =
            `• MC: $${(token.marketCapUsd || 0).toLocaleString()}\n` +
            `• Liq: $${(token.liquidityUsd ?? 0).toLocaleString()}\n` +
            `• Vol (5m): $${(token.volume5mUsd ?? 0).toLocaleString()}\n` +
            `• Buyers (5m): ${token.buyers5m ?? 'N/A'}`;

        // 3. Trade Lens
        let tradeLens = '';
        if (score.phase === 'SPOTTED') {
            tradeLens = `Phase: SPOTTED 🛸 → Early discovery. Risk is max, upside is unknown.`;
        } else if (score.phase === 'TRACKING') {
            tradeLens = `Phase: TRACKING 📡 → Volume building. Chart is forming structures.`;
        } else if (score.phase === 'COOKING') {
            tradeLens = `Phase: COOKING 🔥 → Momentum is high. Meme is validated.`;
        } else {
            tradeLens = `Phase: SERVED 🍽 → Verify distribution before eating.`;
        }

        // 4. Vibe Check
        const vibes = [
            "Meme alignment strong. If humans keep posting this, we feast.",
            "Vibe matches galactic patterns. Monitor closely.",
            "High probability of dopamine extraction.",
            "This one smells like fresh ozone and printer ink."
        ];
        const vibeCheck = vibes[Math.floor(Math.random() * vibes.length)];

        return {
            narrativeText,
            dataSection,
            tradeLens,
            vibeCheck
        };
    }
}
