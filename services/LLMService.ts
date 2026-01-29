import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/Logger';

export interface AIAnalysisResult {
    narrative: string; // The "Story"
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    vibeScore: number; // 0-100
    displayEmoji: string;
}

export class LLMService {

    constructor() { }

    async analyzeToken(symbol: string, tweets: string[]): Promise<AIAnalysisResult | null> {
        if (!config.OPENAI_API_KEY) {
            logger.warn('[LLM] No API Key provided. Skipping AI analysis.');
            return null;
        }

        if (tweets.length === 0) {
            return null;
        }

        const prompt = `
        You are an expert crypto narrative analyst. You identify trends, scams, and alpha early.
        Analyze these recent tweets about the token "$${symbol}".
        
        Tweets:
        ${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}

        Task:
        1. Summarize WHY it is trending (Partnership? Meme? Influencer call? Rug pull warning?).
        2. Assess the RISK level (Low if credible dev/community, High if spam/bot/scammy).
        3. Give a Vibe Score (0-100) based on momentum and legitimacy.

        Output JSON format only:
        {
            "narrative": "One sentence summary in Turkish",
            "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
            "riskReason": "Short reason for risk assessment in Turkish",
            "vibeScore": 85,
            "displayEmoji": "🔥"
        }
        `;

        try {
            const response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: config.AI_MODEL || 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: 'You are a JSON-only crypto analysis bot.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 300,
                    response_format: { type: "json_object" }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                }
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) return null;

            const result = JSON.parse(content);
            return {
                narrative: result.narrative || "Trend analizi yapılamadı.",
                riskLevel: result.riskLevel || 'MEDIUM',
                riskReason: result.riskReason || '',
                vibeScore: result.vibeScore || 50,
                displayEmoji: result.displayEmoji || '🤖'
            };

        } catch (error: any) {
            logger.error(`[LLM] Analysis failed: ${error.message}`);
            return null;
        }
    }
}
