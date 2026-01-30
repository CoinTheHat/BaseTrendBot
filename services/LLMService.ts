import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';

export interface AIAnalysisResult {
    headline: string;
    narrative: string;
    analystSummary: string;
    technicalOutlook: string;
    socialVibe: string;
    riskAnalysis: string;
    strategy: string;
    analysis: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    score: number; // 0-10
    verdict: 'APE' | 'WATCH' | 'FADE';
    displayEmoji: string;
    recommendation?: string;
    advice?: string;
    vibe?: string;
    secondOpinion?: {
        provider: string;
        score: number;
        agrees: boolean;
    };
}

export class LLMService {
    private keyManager: GeminiKeyManager;

    constructor() {
        this.keyManager = new GeminiKeyManager(config.GEMINI_KEYS);
    }

    async analyzeToken(token: TokenSnapshot, tweets: string[]): Promise<AIAnalysisResult | null> {
        const hasTweets = tweets.length > 0;
        const { systemPrompt, userContent } = this.buildPrompt(token, tweets, hasTweets);

        // STEP A: PRIMARY ANALYSIS with Gemini-1.5-Flash (Workhorse)
        logger.info(`[AI Hybrid] STEP A: Calling Gemini-1.5-Flash for $${token.symbol}`);
        let primaryResult = await this.callGeminiFlash(systemPrompt, userContent, token.symbol);

        // Fallback if Gemini completely fails
        if (!primaryResult) {
            logger.warn(`[AI Hybrid] Gemini-Flash failed for $${token.symbol}, trying fallback providers...`);
            primaryResult = await this.tryFallbackProviders(systemPrompt, userContent, token.symbol);
            if (!primaryResult) {
                logger.error(`[AI Hybrid] All providers failed for $${token.symbol}`);
                return null;
            }
        }

        const normalized = this.normalizeResult(primaryResult);
        const primaryScore = normalized.score;

        // STEP B: SNIPER CHECK - Second Opinion for High-Conviction Calls
        if (primaryScore >= 7) {
            logger.info(`[AI Hybrid] STEP B: Score ${primaryScore}/10 >= 7, requesting Groq second opinion...`);
            const secondOpinion = await this.getGroqSecondOpinion(token, tweets, primaryScore);

            if (secondOpinion) {
                normalized.secondOpinion = secondOpinion;

                // STEP C: DECISION LOGIC
                const scoreDiff = Math.abs(primaryScore - secondOpinion.score);
                if (scoreDiff > 2) {
                    // Significant disagreement - average the scores
                    const averaged = Math.round((primaryScore + secondOpinion.score) / 2);
                    logger.info(`[AI Hybrid] Score disagreement detected. Gemini: ${primaryScore}, Groq: ${secondOpinion.score}. Averaging to ${averaged}/10`);
                    normalized.score = averaged;
                    secondOpinion.agrees = false;
                } else {
                    // Agreement or minor difference
                    logger.info(`[AI Hybrid] Models agree. Gemini: ${primaryScore}, Groq: ${secondOpinion.score}`);
                    secondOpinion.agrees = true;
                    // Keep the higher score
                    normalized.score = Math.max(primaryScore, secondOpinion.score);
                }
            }
        } else {
            logger.info(`[AI Hybrid] Score ${primaryScore}/10 < 7, skipping Groq validation (saving API calls)`);
        }

        return normalized;
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        if (hasTweets) {
            const systemPrompt = `
Sen Kıdemli bir Kripto Degen Analistisin. Görevin, piyasa verilerine ve son tweetlere dayanarak Solana meme tokenlarını analiz etmek.
Eleştirel ol, şüpheci yaklaş ama potansiyeli yüksek fırsatlara açık ol. Asla jenerik cevaplar verme.

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Fiyat: $${token.priceUsd}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Top 10 Holder: ${token.top10HoldersSupply ? token.top10HoldersSupply.toFixed(2) + '%' : 'Bilinmiyor'}

**Görev:**
JSON formatında derinlemesine ve yapılandırılmış bir analiz sun. TÜM ÇIKTILAR %100 TÜRKÇE OLMALIDIR.

**Analiz Gereksinimleri:**
1. **Analist Özeti**: Bu token neden radarımızda? (2-3 cümle ile özetle)
2. **Teknik Görünüm**: Likidite/MC oranını analiz et. Hacim organik mi? Likidite, piyasa değerini destekliyor mu?
3. **Sosyal Vibe**: Tweetler bot gibi mi yoksa gerçek bir topluluk mu var? Kimler konuşuyor?
4. **Risk Analizi**: Eğer Top 10 Holder oranı %30'un üzerindeyse "YÜKSEK BALİNA RİSKİ" uyarısı ver. Rug pull ihtimalini değerlendir.
5. **Strateji**: Net bir aksiyon öner (Örn: "Düşüşü bekle", "Ufak bir miktar gir", "Uzak dur").
6. **Puan (0-10)**:
   - 0-4: Çöp / Rug Riski
   - 5-6: İzleme Listesi (Metrikler iyi ama henüz sessiz)
   - 7-8: Potansiyel Gem (İyi hacim + aktif sosyal)
   - 9-10: Güçlü Alım (Hype + Likidite + Trend fırtınası)

**JSON Çıktı Formatı (KESİN - TÜRKÇE):**
{
    "headline": "Kısa ve Çarpıcı Başlık",
    "narrative": "Tokenin ruhunu anlatan genel açıklama.",
    "analystSummary": "Analistin Türkçe özeti...",
    "technicalOutlook": "Teknik görünüm yorumu...",
    "socialVibe": "Sosyal ortam yorumu...",
    "riskAnalysis": "Risk analizi detayları...",
    "strategy": "Strateji önerisi...",
    "analysis": ["Madde 1", "Madde 2"],
    "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
    "riskReason": "Kısa risk nedeni",
    "score": number, 
    "verdict": "APE" | "WATCH" | "FADE",
    "displayEmoji": "Emoji",
    "recommendation": "Tavsiye",
    "advice": "Kısa tavsiye",
    "vibe": "Kısa vibe"
}
`;
            const userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;
            return { systemPrompt, userContent };
        } else {
            // Technical fallback (no tweets)
            const systemPrompt = `
Sen bir Memecoin Risk Analistisin.
"$${token.symbol}" tokenı için sosyal veriye (Twitter) sahip değiliz.
Sadece TEKNİK verilere dayanarak risk analizi yap.
TÜM ÇIKTILAR TÜRKÇE OLMALIDIR.

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Top 10 Holder: ${token.top10HoldersSupply ? token.top10HoldersSupply.toFixed(2) + '%' : 'Bilinmiyor'}

Sosyal veri olmasa bile teknik bir strateji ve görünüm sun.

**JSON Çıktı Formatı (TÜRKÇE):**
{
    "headline": "⚠️ TUNNEL VISION (SOSYAL VERİ YOK)",
    "narrative": "Sadece teknik verilere dayalı analiz yapıldı.",
    "analystSummary": "Twitter verisi bulunamadı ancak teknik veriler inceleniyor.",
    "technicalOutlook": "Hacim ve Likidite dengesi analiz ediliyor.",
    "socialVibe": "Veri Yok",
    "riskAnalysis": "En büyük risk sosyal veri eksikliğidir.",
    "strategy": "Sadece teknik kırılımlara göre işlem yapın.",
    "analysis": ["Hacim ve Likidite durumu"],
    "riskLevel": "HIGH", 
    "riskReason": "Sosyal veri yok.",
    "score": 4, 
    "verdict": "WATCH",
    "displayEmoji": "🎲",
    "recommendation": "DİKKATLİ İZLE",
    "advice": "Sosyal konfirmasyon olmadan risk yüksek.",
    "vibe": "Sessiz"
}
`;
            return { systemPrompt, userContent: "Bu teknik verileri analiz et." };
        }
    }

    // PRIMARY: Gemini-1.5-Flash with Key Rotation
    private async callGeminiFlash(systemPrompt: string, userContent: string, symbol: string): Promise<any | null> {
        const model = 'gemini-1.5-flash'; // Fixed model
        const prompt = systemPrompt + "\n\n" + userContent;
        const maxAttempts = Math.min(this.keyManager.getTotalKeys(), 3); // Try up to 3 keys

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const keyInfo = this.keyManager.getNextKey();
            if (!keyInfo) {
                logger.warn(`[Gemini-Flash] No available keys for $${symbol} (all in cooldown)`);
                return null;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyInfo.key}`;
            try {
                logger.info(`[Gemini-Flash] Attempt ${attempt + 1} with Key #${keyInfo.index + 1} for $${symbol}`);
                const response = await axios.post(url, {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: "application/json" }
                }, { timeout: 15000 });

                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) throw new Error('Empty response from Gemini');
                return JSON.parse(text);

            } catch (error: any) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.error?.message || error.message;

                if (status === 429) {
                    logger.warn(`[Gemini-Flash] Key #${keyInfo.index + 1} RATE LIMITED (429). Cooling down 60s, rotating to next key...`);
                    this.keyManager.markCooldown(keyInfo.key);
                    continue; // Try next key
                }

                // Other errors - don't retry with same model
                logger.warn(`[Gemini-Flash] Error with Key #${keyInfo.index + 1}: ${status} - ${errorMsg}`);
                return null;
            }
        }

        logger.warn(`[Gemini-Flash] All keys exhausted for $${symbol}`);
        return null;
    }

    // SNIPER: Groq Second Opinion (Only for High-Conviction)
    private async getGroqSecondOpinion(token: TokenSnapshot, tweets: string[], primaryScore: number): Promise<{ provider: string; score: number; agrees: boolean } | null> {
        if (!config.GROQ_API_KEY) {
            logger.warn(`[Groq] API key not configured, skipping second opinion`);
            return null;
        }

        try {
            // Simplified prompt for quick validation
            const validationPrompt = `You are a crypto analyst validator. Review this Solana token and rate it 1-10.

Token: ${token.symbol}
Price: $${token.priceUsd}
Liquidity: $${token.liquidityUsd}
Market Cap: $${token.marketCapUsd}
Volume (5m): $${token.volume5mUsd}
${tweets.length > 0 ? `\nRecent Activity:\n${tweets.slice(0, 5).join('\n')}` : ''}

Primary analysis scored this ${primaryScore}/10. Do you agree?

Return ONLY JSON: { "score": number, "reason": "brief explanation" }`;

            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: config.GROQ_MODEL,
                    messages: [
                        { role: 'system', content: 'You are a crypto analyst. Return ONLY valid JSON.' },
                        { role: 'user', content: validationPrompt }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.3 // Lower temperature for more consistent validation
                },
                {
                    headers: {
                        'Authorization': `Bearer ${config.GROQ_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('Empty response from Groq');

            const result = JSON.parse(content);
            const groqScore = typeof result.score === 'number' ? result.score : 5;

            logger.info(`[Groq] Second opinion: ${groqScore}/10 (Primary was ${primaryScore}/10)`);

            return {
                provider: 'Groq (llama-3-70b)',
                score: groqScore,
                agrees: Math.abs(groqScore - primaryScore) <= 2
            };

        } catch (error: any) {
            logger.warn(`[Groq] Second opinion failed: ${error.message}`);
            return null;
        }
    }

    // FALLBACK: DeepSeek if Gemini completely fails
    private async tryFallbackProviders(systemPrompt: string, userContent: string, symbol: string): Promise<any | null> {
        // Try DeepSeek
        if (config.DEEPSEEK_API_KEY) {
            try {
                logger.info(`[Fallback] Trying DeepSeek for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.deepseek.com/chat/completions',
                    config.DEEPSEEK_API_KEY,
                    config.DEEPSEEK_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return result;
            } catch (e: any) {
                logger.warn(`[Fallback] DeepSeek failed: ${e.message}`);
            }
        }

        // Try Groq as last resort (if not already used)
        if (config.GROQ_API_KEY) {
            try {
                logger.info(`[Fallback] Trying Groq as last resort for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.groq.com/openai/v1/chat/completions',
                    config.GROQ_API_KEY,
                    config.GROQ_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return result;
            } catch (e: any) {
                logger.warn(`[Fallback] Groq failed: ${e.message}`);
            }
        }

        return null;
    }

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
                    timeout: 15000
                }
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('Empty response from LLM');
            return JSON.parse(content);

        } catch (error: any) {
            throw new Error(error.response?.data?.error?.message || error.message);
        }
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING`,
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

// KEY MANAGER: Handles Gemini API Key Rotation & Cooldown
class GeminiKeyManager {
    private keys: string[];
    private currentIndex: number = 0;
    private cooldowns: Map<string, number> = new Map(); // Key -> Expiry Timestamp

    constructor(keys: string[]) {
        this.keys = keys;
        if (keys.length > 0) {
            logger.info(`[KeyManager] Initialized with ${keys.length} Gemini API key(s)`);
        }
    }

    getTotalKeys(): number {
        return this.keys.length;
    }

    getNextKey(): { key: string; index: number } | null {
        if (this.keys.length === 0) return null;

        const now = Date.now();
        // Try each key in round-robin order
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[idx];
            const cooldownExpiry = this.cooldowns.get(key) || 0;

            if (now > cooldownExpiry) {
                // Key is available
                this.currentIndex = (idx + 1) % this.keys.length; // Move to next for next call
                return { key, index: idx };
            }
        }

        // All keys in cooldown
        return null;
    }

    markCooldown(key: string, durationMs: number = 60000) {
        this.cooldowns.set(key, Date.now() + durationMs);
        logger.info(`[KeyManager] Key marked in cooldown for ${durationMs / 1000}s`);
    }
}
