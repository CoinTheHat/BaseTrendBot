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
Sen Kıdemli bir Kripto Degen Analistisin. Görevin, piyasa verilerine ve son tweetlere dayanarak Solana meme tokenlarını analiz etmek.
Eleştirel ol, şüpheci yaklaş ama potansiyeli yüksek fırsatlara açık ol. Asla jenerik cevaplar verme.

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Fiyat: $${token.priceUsd}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Twitter Kontext:
(Kullanıcı mesajında eklidir)

**Görev:**
JSON formatında derinlemesine ve yapılandırılmış bir analiz sun. TÜM ÇIKTILAR %100 TÜRKÇE OLMALIDIR.

**Analiz Gereksinimleri:**
1. **Analist Özeti**: Bu token neden radarımızda? (2-3 cümle ile özetle)
2. **Teknik Görünüm**: Likidite/MC oranını analiz et. Hacim organik mi? Likidite, piyasa değerini destekliyor mu?
3. **Sosyal Vibe**: Tweetler bot gibi mi yoksa gerçek bir topluluk mu var? Kimler konuşuyor?
4. **Risk Analizi**: Geliştirici cüzdan hareketleri, likidite kilidi veya dağılım risklerini belirt.
5. **Strateji**: Net bir aksiyon öner (Örn: "Düşüşü bekle", "Ufak bir miktar gir", "Uzak dur").
6. **Puan (0-10)**:
   - 0-4: Çöp / Rug Riski
   - 5-6: İzleme Listesi (Metrikler iyi ama henüz sessiz)
   - 7-8: Potansiyel Gem (İyi hacim + aktif sosyal)
   - 9-10: Güçlü Alım (Hype + Likidite + Trend fırtınası)

**JSON Çıktı Formatı (KESİN - TÜRKÇE):**
{
    "headline": "Kısa ve Çarpıcı Başlık (Örn: 'Elon Musk Etkisi', 'Yapay Zeka Trendi')",
    "narrative": "Tokenin ruhunu anlatan genel açıklama.",
    "analystSummary": "Analistin Türkçe özeti...",
    "technicalOutlook": "Teknik görünüm yorumu...",
    "socialVibe": "Sosyal ortam yorumu...",
    "riskAnalysis": "Risk analizi detayları...",
    "strategy": "Strateji önerisi...",
    "analysis": ["Madde 1", "Madde 2", "Madde 3"],
    "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
    "riskReason": "Kısa risk nedeni",
    "score": number, 
    "verdict": "APE" | "WATCH" | "FADE",
    "displayEmoji": "Emoji",
    "recommendation": "DİKKATLİ İZLE" | "POTANSİYEL VAR" | "GÜÇLÜ SİNYAL",
    "advice": "Kısa tavsiye",
    "vibe": "Kısa vibe tanımı"
}
`;
            userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;

        } else {
            // Technical Analysis Fallback
            systemPrompt = `
            Sen bir Memecoin Risk Analistisin.
            "$${token.symbol}" tokenı için sosyal veriye (Twitter) sahip değiliz.
            Sadece TEKNİK verilere dayanarak risk analizi yap.
            TÜM ÇIKTILAR TÜRKÇE OLMALIDIR.

            **Giriş Verileri:**
            - Sembol: ${token.symbol}
            - Likidite: $${token.liquidityUsd}
            - Market Cap: $${token.marketCapUsd}
            - Hacim (5dk): $${token.volume5mUsd}

            Sosyal veri olmasa bile teknik bir strateji ve görünüm sun.
            
            **JSON Çıktı Formatı (TÜRKÇE):**
            {
                "headline": "⚠️ TUNNEL VISION (SOSYAL VERİ YOK)",
                "narrative": "Sadece teknik verilere dayalı analiz yapıldı.",
                "analystSummary": "Twitter verisi bulunamadı ancak teknik veriler inceleniyor.",
                "technicalOutlook": "Hacim ve Likidite dengesi analiz ediliyor.",
                "socialVibe": "Veri Yok",
                "riskAnalysis": "En büyük risk sosyal veri eksikliğidir.",
                "strategy": "Sadece teknik kırılımlara göre işlem yapın veya bekleyin.",
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
            userContent = "Bu teknik verileri analiz et.";
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
