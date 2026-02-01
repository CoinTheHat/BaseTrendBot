import OpenAI from "openai";
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
}

export class LLMService {
    private xai: OpenAI;

    constructor() {
        if (!config.XAI_API_KEY) {
            logger.error('[LLMService] CRITICAL: XAI_API_KEY is missing! Bot cannot function.');
            process.exit(1);
        }
        this.xai = new OpenAI({
            apiKey: config.XAI_API_KEY,
            baseURL: "https://api.x.ai/v1",
        });
    }

    async analyzeToken(token: TokenSnapshot, tweets: string[]): Promise<AIAnalysisResult | null> {
        const hasTweets = tweets.length > 0;
        const { systemPrompt, userContent } = this.buildPrompt(token, tweets, hasTweets);

        try {
            logger.info(`[xAI Grok] Analyzing $${token.symbol} with ${config.XAI_MODEL || 'grok-2-1212'}...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-2-1212", // Ultra Low Cost Model
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.2,
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('Empty response from xAI');

            const result = JSON.parse(content);
            return this.normalizeResult(result);

        } catch (error: any) {
            logger.error(`[xAI Grok] Analysis failed for $${token.symbol}: ${error.message}`);

            if (error.status === 401 || error.message.includes('API key')) {
                logger.error('[xAI Grok] FATAL: Invalid API Key. Please check config.');
                // Don't exit process, just stop analysis
            }
            return null;
        }
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        const systemPrompt = `
Sen Kıdemli bir Kripto Degen Analistisin (xAI Grok tabanlı). Görevin, piyasa verilerine ve son tweetlere dayanarak Solana meme tokenlarını analiz etmek.
Eleştirel ol, şüpheci yaklaş ama potansiyeli yüksek fırsatlara açık ol. Asla jenerik cevaplar verme.

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Fiyat: $${token.priceUsd}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Fiyat Değişimi (5dk): %${token.priceChange5m}
- Token Yaşı: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / (3600 * 1000)) + ' Saat' : 'Bilinmiyor'}
- Zemin Oranı (Liq/MC): ${((token.liquidityUsd || 0) / (token.marketCapUsd || 1)).toFixed(3)} ${((token.liquidityUsd || 0) / (token.marketCapUsd || 1)) >= 0.20 ? '✅ Sağlam' : '⚠️ Zayıf'}
- Top 10 Holder: ${token.top10HoldersSupply ? token.top10HoldersSupply.toFixed(2) + '%' : 'Bilinmiyor'}

**Görev:**
JSON formatında derinlemesine ve yapılandırılmış bir analiz sun. TÜM ÇIKTILAR %100 TÜRKÇE OLMALIDIR.

**PUANLAMA AYARLARI & KURALLAR (SCORING RULES):**

### 1. ⏳ TOKEN YAŞI KURALLARI (Time Decay)
Bu kuralları puan verirken KESİNLİKLE uygula:
- **0 - 4 Saat:** 🟢 **PRIME TIME.** Keşif bölgesi. Ceza yok. (Tam puan potansiyeli).
- **4 - 12 Saat:** 🟡 **SÜRDÜRÜLEBİLİRLİK KONTROLÜ.** Hype hala canlı mı? Hacim düşüyorsa -1 Puan kır.
- **12 - 24 Saat:** 🟠 **DİKKAT BÖLGESİ.** Trend dönüşü riski. Çok seçici ol.
- **> 24 Saat:** 🔴 **ESKİ HABER.** Eğer devasa bir breakout (yeni ATH) yoksa, final puandan **OTOMATİK OLARAK 1-2 PUAN DÜŞ**.

### 2. 📈 FİYAT HAREKETİ UYARISI (FOMO Koruması)
- **5 Dakikalık Mum Kuralı:** 'Fiyat Değişimi (5dk)' verisine bak.
- **EĞER > %30 ARTIŞ VARSA:** 🚨 **TEHLİKE.** Token dikine (vertical) gidiyor.
  - **AKSİYON:** Final puandan 1-2 puan düş.
  - **UYARI:** Strateji kısmına ŞUNU YAZ: "⚠️ DİKKAT: Son 5 dakikada %${token.priceChange5m} pump yaptı. RSI şişmiş olabilir, tepeden alma. Geri çekilme (Retrace) bekle."

**Analiz Gereksinimleri:**
0. **Dil ve Üslup:** Türkçe kripto jargonunu doğal ve profesyonel kullan.
1. **Analist Özeti**: Bu token neden radarımızda?
2. **Teknik Görünüm**: Likidite ve Hacim yorumla.
3. **Sosyal Vibe**: Topluluk gerçek mi?
4. **Risk Analizi**: Balina ve Rug riski.
5. **Strateji**: Net aksiyon öner. (FOMO Korumasını uygula).
6. **Puan (0-10)**: (Yukarıdaki kurallara göre cezaları uygula).
   - 0-4: Çöp / Rug Riski
   - 5-6: İzleme Listesi
   - 7-8: Potansiyel Gem
   - 9-10: HIGH CONVICTION / APE

**JSON Çıktı Formatı (KESİN):**
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
        const userContent = hasTweets
            ? `Tweets:\n${tweets.slice(0, 20).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`
            : `Twitter verisi yok. Sadece teknik verileri analiz et. Risk seviyesini yüksek tut.`;

        return { systemPrompt, userContent };
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

    async analyzeTweetBatch(tweets: { id: string; text: string; author?: string }[]): Promise<Array<{ symbol: string; sentiment: string; reason: string; source_id: string }>> {
        if (tweets.length === 0) return [];

        // Tweetleri numaralandırarak birleştiriyoruz, Author bilgisini ekliyoruz
        const userContent = tweets.map(t => {
            const authorPart = t.author ? ` (Author: @${t.author})` : '';
            return `ID_${t.id}${authorPart}: ${t.text.replace(/\n/g, ' ')}`;
        }).join('\n\n');

        const systemPrompt = `
You are an expert Crypto Trend Hunter (Jeweler Mode).
Analyze the provided tweets (Format: "ID_xxx (Author: @user): Content") regarding ERC-8004, Hybrid Tokens, or new tech trends.

**STRICT RULES:**
1. Ignore spam, airdrops, giveaways, and generic empty hype.
2. Identify only HIGH POTENTIAL projects with real community interest or solid tech mentions.
3. Look for Contract Addresses (CA) or Tickers ($SYM).
4. OUTPUT MUST BE VALID JSON.
5. **BOOST SCORE**: If tweet is from a known Alpha Account (e.g. 8004_scan, 8004tokens, DavideCrapis), give it higher sentiment and trust.

**JSON OUTPUT FORMAT:**
{
  "gems": [
    { 
      "symbol": "$SYMBOL", 
      "sentiment": "Score 1-10", 
      "reason": "Short summary explaining why it is a gem (IN TURKISH LANGUAGE)",
      "source_id": "Extract the numeric ID from the input (e.g. if input is ID_12345, output '12345')"
    }
  ]
}
If no gems found, return: { "gems": [] }
`;

        try {
            logger.info(`[xAI Grok] Batch analyzing ${tweets.length} tweets...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.1, // Düşük sıcaklık = Daha tutarlı JSON
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) return [];

            const parsed = JSON.parse(content);
            // Artık "gems" anahtarının geleceğinden eminiz
            return parsed.gems || [];

        } catch (err) {
            logger.error(`[xAI Batch] Analysis failed: ${err}`);
            return [];
        }
    }
}
