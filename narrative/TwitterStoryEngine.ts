import { TokenSnapshot, Narrative } from '../models/types';

export class TwitterStoryEngine {
    buildStory(token: TokenSnapshot, tweets: string[]): { summary: string; sampleLines: string[] } {
        if (!tweets || tweets.length === 0) {
            return {
                summary: "No clear Twitter chatter yet. Probably very early or ignored.",
                sampleLines: []
            };
        }

        // 1. Analyze Vibe
        const joined = tweets.join(' ').toLowerCase();
        let vibe = "Neutral";

        if (joined.includes('scam') || joined.includes('rug')) vibe = "Suspicious/FUD";
        else if (joined.includes('moon') || joined.includes('gem') || joined.includes('send')) vibe = "Hype/Shill";
        else if (joined.includes('funny') || joined.includes('lol') || joined.includes('me_irl')) vibe = "Meme/Relatable";

        // 2. Build Summary
        let summary = `Detected ${tweets.length} recent tweets. Vibe seems **${vibe}**. `;

        if (vibe === "Hype/Shill") {
            summary += "Mostly shilling and price speculation found.";
        } else if (vibe === "Meme/Relatable") {
            summary += "Community is engaging with memes and jokes about the token.";
        } else if (vibe === "Suspicious/FUD") {
            summary += "⚠️ Caution: Some users are calling it a scam or rug.";
        } else {
            summary += "Conversation is mixed or generic.";
        }

        // 3. Pick Samples (Clean them up)
        const sampleLines = tweets
            .slice(0, 3)
            .map(t => t.replace(/\n/g, ' ').substring(0, 100) + (t.length > 100 ? '...' : ''))
            .map(t => `- "${t}"`);

        return { summary, sampleLines };
    }
}
