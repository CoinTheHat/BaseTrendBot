import { TokenSnapshot, Narrative } from '../models/types';

export class TwitterStoryEngine {
    buildStory(token: TokenSnapshot, tweets: string[]): { summary: string; sampleLines: string[]; trustScore: number; riskAnalysis: { level: any; flags: string[] } } {
        if (!tweets || tweets.length === 0) {
            return {
                summary: "No clear Twitter chatter yet.",
                sampleLines: [],
                trustScore: 50,
                riskAnalysis: { level: "UNKNOWN", flags: [] }
            };
        }

        // 1. Analyze Vibe (User's Weighted Logic)
        const redFlags = ['scam', 'rug', 'honeypot', 'fake', 'avoid', 'stolen', 'drain'];
        const greenFlags = ['gem', 'moon', 'early', 'organic', 'lfg', 'chill', 'based', 'doxxed', 'audit'];

        let detectedRed = 0;
        let detectedGreen = 0;
        const foundRedFlags: string[] = [];

        // Count occurrences per tweet
        tweets.forEach(tweet => {
            const lowerTweet = tweet.toLowerCase();
            redFlags.forEach(word => {
                if (lowerTweet.includes(word)) {
                    detectedRed++;
                    if (!foundRedFlags.includes(word)) foundRedFlags.push(word);
                }
            });
            greenFlags.forEach(word => { if (lowerTweet.includes(word)) detectedGreen++; });
        });

        let trustScore = 50; // Neutral start
        trustScore = trustScore + (detectedGreen * 5) - (detectedRed * 20);
        trustScore = Math.max(0, Math.min(100, trustScore));

        // Determine Risk Level
        let riskLevel: "SAFE" | "UNKNOWN" | "SUSPICIOUS" | "DANGEROUS" = "MEDIUM" as any;
        if (trustScore > 75) riskLevel = "SAFE";
        else if (trustScore < 40) riskLevel = "SUSPICIOUS";

        if (detectedRed > 2 || trustScore < 20) riskLevel = "DANGEROUS";
        if (tweets.length < 3) riskLevel = "UNKNOWN";

        // 2. Build Summary
        let vibe = "Neutral";
        if (riskLevel === "DANGEROUS") vibe = "TOXIC ☣️";
        else if (trustScore > 80) vibe = "SAFU/HYPE 🚀";
        else if (detectedGreen > detectedRed) vibe = "Positive";

        let summary = `Analiz edilen ${tweets.length} tweet içerisinde **${detectedGreen}** pozitif, **${detectedRed}** negatif sinyal bulundu. Vibe: ${vibe}.`;

        if (foundRedFlags.length > 0) {
            summary += `\n⛔ **Risk Sinyalleri:** ${foundRedFlags.join(', ')}`;
        }

        // 3. Pick Samples
        const sampleLines = tweets
            .filter(t => t.length > 30)
            .slice(0, 3)
            .map(t => t.replace(/\n/g, ' ').substring(0, 100) + (t.length > 100 ? '...' : ''))
            .map(t => `- "${t}"`);

        return { summary, sampleLines, trustScore, riskAnalysis: { level: riskLevel, flags: foundRedFlags } };
    }
}
