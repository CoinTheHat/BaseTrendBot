import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types'; // Correct import path

export interface AIAnalysisResult {
    headline: string;
    narrative: string; // Key snippet for compatibility
    analystSummary: string; // 🧐 New: 2-3 sentences summary
    technicalOutlook: string; // 📊 New: Liq/MC, Volume sustainability
    socialVibe: string; // 🗣️ New: Bot vs Real community check
    riskAnalysis: string; // 🚩 New: Dev, Liq Lock, Sell Pressure
    strategy: string; // 🚀 New: Entry/Wait advice
    analysis: string[]; // Key insights (Points)
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    score: number; // 0-10
    verdict: 'APE' | 'WATCH' | 'FADE';
    displayEmoji: string;
    recommendation?: string;
    advice?: string;
    vibe?: string;
}

export class LLMService {
    private keyManager: GeminiKeyManager;

    constructor() {
        this.keyManager = new GeminiKeyManager(config.GEMINI_KEYS);
    }

    async analyzeToken(token: TokenSnapshot, tweets: string[]): Promise<AIAnalysisResult | null> {
        const hasTweets = tweets.length > 0;
        let systemPrompt = '';
        let userContent = '';

        if (hasTweets) {
            systemPrompt = `
You are a Senior Crypto Degen Analyst. Your job is to analyze a Solana meme token based on market data and recent tweets.
Be critical, skeptical, but open to high-potential plays. Do not be generic.

**Input Data:**
- Symbol: ${token.symbol}
- Price: $${token.priceUsd}
- Liquidity: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Volume (5m): $${token.volume5mUsd}
- Twitter Context:
(Attached in User Message)

**Task:**
Provide a deep, structured analysis in JSON format.

**Analysis Requirements:**
1. **Analyst Summary**: Why is this token on the radar? (2-3 sentences)
2. **Technical Outlook**: Analyze Liq/MC ratio. Is the volume organic? Is the liquidity sufficient for the market cap?
3. **Social Vibe**: Are tweets generic/bot-like or authentic/cult-like? Who is talking about it?
4. **Risk Analysis**: Mention Dev wallet action (if known or general risk), Liquidity Safety, Holder distribution risk.
5. **Strategy**: Suggest an action (e.g., "Wait for dip", "Ape small", "Fade").
6. **Score (0-10)**:
   - 0-4: Trash/Rug Risk
   - 5-6: Watchlist (Good metrics but early/quiet)
   - 7-8: Potential Gem (Good volume + active socials)
   - 9-10: Strong Buy (Perfect storm of Hype + Liq + Trend)

**JSON Output Format (Strict):**
{
    "headline": "Short Catchy Title (e.g. 'Elon Narrative Play')",
    "narrative": "General description...",
    "analystSummary": "...",
    "technicalOutlook": "...",
    "socialVibe": "...",
    "riskAnalysis": "...",
    "strategy": "...",
    "analysis": ["Bullet 1", "Bullet 2", "Bullet 3"],
    "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
    "riskReason": "Short reason",
    "score": number, 
    "verdict": "APE" | "WATCH" | "FADE",
    "displayEmoji": "Emoji",
    "recommendation": "Turkish Action (e.g. 'DİKKATLİ İZLE', 'POTANSİYEL VAR', 'GÜÇLÜ SİNYAL')",
    "advice": "Short tip",
    "vibe": "Short vibe desc"
}
`;
            userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;

        } else {
            // Technical Analysis Fallback
            systemPrompt = `
            You are a Risk Analyst for Memecoins. 
            We have NO social data (Twitter) for the token "$${token.symbol}".
            Analyze risk based PURELY on technicals.

            **Input Data:**
            - Symbol: ${token.symbol}
            - Liquidity: $${token.liquidityUsd}
            - Market Cap: $${token.marketCapUsd}
            - Volume (5m): $${token.volume5mUsd}

            Output Strict JSON (Turkish). Even without socials, provide a technical strategy and outlook.
            
            JSON Output Format:
            {
                "headline": "⚠️ TUNNEL VISION (NO SOCIALS)",
                "narrative": "Sadece teknik verilere dayalı analiz.",
                "analystSummary": "Twitter verisi yok ancak teknik veriler inceleniyor.",
                "technicalOutlook": "Hacim ve Likidite durumu analiz ediliyor.",
                "socialVibe": "Veri Yok",
                "riskAnalysis": "Sosyal veri eksikliği en büyük risk.",
                "strategy": "Teknik trade veya bekle.",
                "analysis": ["Hacim ve Likidite durumu"],
                "riskLevel": "HIGH", 
                "riskReason": "Sosyal veri yok.",
                "score": 4, 
                "verdict": "WATCH",
                "displayEmoji": "🎲",
                "recommendation": "DİKKATLİ İZLE",
                "advice": "Sosyal kanıt yok, risk yüksek.",
                "vibe": "Sessiz"
            }
            `;
            userContent = "Analyze this technical data.";
        }

        return await this.generateAnalysis(systemPrompt, userContent, token.symbol);
    }

    private async generateAnalysis(systemPrompt: string, userContent: string, symbol: string): Promise<AIAnalysisResult | null> {

        // 1. Try GROQ (Primary)
        if (config.GROQ_API_KEY) {
            try {
                logger.info(`[AI Router] Trying Primary: Groq (${config.GROQ_MODEL}) for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.groq.com/openai/v1/chat/completions',
                    config.GROQ_API_KEY,
                    config.GROQ_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return this.normalizeResult(result);
            } catch (e: any) {
                logger.warn(`[AI Router] Groq failed for $${symbol} (${e.message}), switching to DeepSeek...`);
            }
        }

        // 2. Try DEEPSEEK (Fallback)
        if (config.DEEPSEEK_API_KEY) {
            try {
                logger.info(`[AI Router] Trying Fallback: DeepSeek (${config.DEEPSEEK_MODEL}) for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.deepseek.com/chat/completions',
                    config.DEEPSEEK_API_KEY,
                    config.DEEPSEEK_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return this.normalizeResult(result);
            } catch (e: any) {
                logger.warn(`[AI Router] DeepSeek failed for $${symbol} (${e.message}), switching to Gemini...`);
            }
        }

        // 3. Try GEMINI (Last Resort)
        if (this.keyManager.hasKeys()) {
            logger.info(`[AI Router] Trying Last Resort: Gemini for $${symbol}`);
            const result = await this.tryGeminiWithRotation(config.AI_MODEL, systemPrompt, userContent, symbol);
            if (result) return result; // Already normalized
        }

        logger.error(`[AI Router] All Providers Failed for $${symbol}`);
        return null; // All failed
    }

    // Generic Helper for OpenAI-Compatible APIs (Groq, DeepSeek)
    private async callOpenAICompatible(endpoint: string, apiKey: string, model: string, system: string, user: string): Promise<any | null> {
        try {
            const response = await axios.post(
                endpoint,
                {
                    model: model,
                    messages: [
                        { role: 'system', content: system + "\n IMPORTANT: Return ONLY valid JSON." },
                        { role: 'user', content: user }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.5
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000 // 15s timeout
                }
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('Empty response from LLM');
            return JSON.parse(content);

        } catch (error: any) {
            throw new Error(error.response?.data?.error?.message || error.message);
        }
    }

    private async tryGeminiWithRotation(initialModel: string, systemPrompt: string, userContent: string, symbol: string): Promise<AIAnalysisResult | null> {
        const fallbacks = ['gemini-2.0-flash-exp', 'gemini-2.5-flash', 'gemini-1.5-flash'];
        const uniqueModels = [...new Set([initialModel, ...fallbacks])];

        for (const currentModel of uniqueModels) {
            const result = await this.callGeminiAutoRotate(currentModel, systemPrompt + "\n\n" + userContent, symbol);
            if (result) {
                return this.normalizeResult(result);
            }
        }
        return null;
    }

    private async callGeminiAutoRotate(model: string, prompt: string, symbol: string): Promise<any | null> {
        const maxRetries = 2;
        let attempts = 0;

        while (attempts < maxRetries) {
            const keyInfo = this.keyManager.getNextKey();
            if (!keyInfo) {
                logger.warn(`[LLM] Gemini: No available keys for $${symbol} (all cooled down or missing).`);
                return null;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyInfo.key}`;
            try {
                const response = await axios.post(url, {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: "application/json" }
                }, { timeout: 15000 }); // 15s timeout
                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                return text ? JSON.parse(text) : null;
            } catch (error: any) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.error?.message || error.message;
                if (status === 429) {
                    logger.warn(`[LLM] Gemini Key #${keyInfo.index + 1} QUOTA EXCEEDED (429) for $${symbol}. Cooldown 60s.`);
                    this.keyManager.markCooldown(keyInfo.key);
                    attempts++;
                    continue;
                }
                logger.warn(`[LLM] Gemini attempt (${model}) failed for $${symbol}: ${status} - ${errorMsg}`);
                return null;
            }
        }
        logger.warn(`[LLM] Gemini: Max retries exhausted for $${symbol} with model ${model}.`);
        return null;
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING: ${config.AI_MODEL}`,
            narrative: result.narrative || "Trend analizi yapılamadı.",
            analystSummary: result.analystSummary || "Özet yok.",
            technicalOutlook: result.technicalOutlook || "Teknik veri yok.",
            socialVibe: result.socialVibe || "Vibe verisi yok.",
            riskAnalysis: result.riskAnalysis || "Risk analizi yok.",
            strategy: result.strategy || "Strateji yok.",
            analysis: result.analysis || ["Veri yetersiz."],
            riskLevel: result.riskLevel || 'MEDIUM',
            riskReason: result.riskReason || '',
            score: typeof result.score === 'number' ? result.score : 5,
            verdict: result.verdict || 'WATCH',
            displayEmoji: result.displayEmoji || '🤖',
            recommendation: result.recommendation || 'DİKKATLİ İZLE',
            advice: result.advice || '',
            vibe: result.vibe || ''
        };
    }
}

class GeminiKeyManager {
    private keys: string[];
    private currentIndex: number = 0;
    private cooldowns: Map<string, number> = new Map(); // Key -> Cooldown Expiry Timestamp

    constructor(keys: string[]) {
        this.keys = keys;
    }

    hasKeys(): boolean {
        return this.keys.length > 0;
    }

    getNextKey(): { key: string, index: number } | null {
        if (this.keys.length === 0) return null;
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const ptr = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[ptr];
            if (now > (this.cooldowns.get(key) || 0)) {
                this.currentIndex = (ptr + 1) % this.keys.length;
                return { key, index: ptr };
            }
        }
        return null;
    }

    markCooldown(key: string) {
        this.cooldowns.set(key, Date.now() + 60000);
    }
}
