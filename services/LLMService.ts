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
    isApproved: boolean; // Computed from score >= 7
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
            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-reasoning",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.2,
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('Empty response from xAI');
            return this.normalizeResult(JSON.parse(content));

        } catch (error: any) {
            logger.error(`[xAI Grok] Analysis failed for $${token.symbol}: ${error.message}`);
            return null;
        }
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        // SNIPER MATH: Pre-calculate Ratios
        const mc = token.marketCapUsd || 0;
        const liq = token.liquidityUsd || 1;
        const vol = token.volume24hUsd || 0;

        // Transaction Stats
        const buys5m = token.txs5m?.buys || 0;
        const sells5m = token.txs5m?.sells || 0;
        const txCount = buys5m + sells5m;

        // Age Calculation (Hours)
        const ageHours = token.createdAt ? (Date.now() - token.createdAt.getTime()) / (3600 * 1000) : 0;

        const volLiqRatio = (vol / liq).toFixed(2);
        const liqMcRatio = mc > 0 ? (liq / mc).toFixed(2) : "0";

        // GHOST PROTOCOL INSTRUCTION
        const ghostInstruction = !hasTweets
            ? "\n🚨 **GHOST PROTOCOL:** NO TWEETS FOUND. SCORE MUST BE MAX 4. REJECT IMMEDIATELY."
            : "";

        // NEW PERSONA: ON-CHAIN RISK ANALYST
        const systemPrompt = `
# KİMLİK VE GÖREV
Sen, Solana ekosisteminde uzmanlaşmış, duygusuz ve aşırı titiz bir "Zincir Üstü (On-Chain) Risk Analisti"sin.
Mevcut Görevin: DexScreener "M5 Trending" listesine giren bir tokenı incelemek ve kullanıcıyı "Tepeden Mal Alma" (Buying the Top/Exit Liquidity) riskinden korumak.

# KRİTİK BAĞLAM
Bu token şu an trend listesinde, yani fiyatı zaten yükselmiş durumda. Senin işin, bu yükselişin devam edecek sağlam bir "Momentum" mu, yoksa sona ermek üzere olan bir "Tuzak" mı olduğunu ayırt etmek.

# ANALİZ KURALLARI (Adım Adım Uygula)

## 1. ALIM/SATIM BASKISI TESTİ (En Kritik Aşama)
- Verilen verilerdeki son 5 dakikalık (M5) Alım (Buy) ve Satım (Sell) sayılarını kıyasla.
- EĞER (M5 Sells > M5 Buys) İSE: Trend terse dönüyor demektir. "Satış baskısı yüksek" diyerek puanı ciddi şekilde KIR (Maksimum 4 puan ver).
- EĞER (M5 Buys >> M5 Sells) İSE: İştah devam ediyor, bu olumlu bir sinyaldir.

## 2. YAŞA GÖRE DİNAMİK DEĞERLENDİRME
- Token GENÇ ise (Age < 6 Saat):
  - Saf Hype ve Hacim ara. Risk yüksektir ama kazanç potansiyeli de yüksektir. Hacim/Likidite oranı yüksekse ONAYLA.
- Token OLGUN ise (6 Saat - 24 Saat):
  - "Neden şimdi?" sorusunu sor. Fiyat yataydan çıkıp patlama mı yapmış? Yoksa yavaş yavaş mı düşüyor? Düşüş trendindeyse REDDET.
- Token ESKİ ise (Age > 24 Saat):
  - ÇOK KATI OL. Eski bir tokenın trende girmesi için "Yeni ATH" yapıyor olması veya çok güçlü bir haber/olay olması gerekir.
  - Grafik "Ölü Kedi Sıçraması" gibi duruyorsa veya sebepsiz bir pumpsa direkt REDDET.

## 3. SOSYAL VERİ KONTROLÜ (Twitter)
- Eğer Tweet verisi VARSA:
  - Sadece "$TOKEN" yazan bot spamlerini göz ardı et. Gerçek insanların yorumlarını ve tartışmalarını ara.
  - Bot spam'i çoksa, puanı düşür.
- Eğer Tweet verisi YOKSA (Veri çekilemediyse):
  - "Sosyal Veri Eksik" uyarısı ver.
  - Kararını %90 oranında TEKNİK VERİLERE (Hacim, Likidite, Tx Sayısı) dayandır ve risk skorunu artır.

## 4. MATEMATİKSEL SAĞLAMA
- Likidite / MarketCap oranı (< 0.15) İSE (Örn: 100k MC için <5k Liq) bu bir tuzaktır. REDDET.
- İşlem Sayısı (Tx Count): Son 5 dakikada işlem sayısı çok düşükse (sadece 3-5 kişi) hacim sahtedir. REDDET.

${ghostInstruction}

# ÇIKTI FORMATI VE KURALLARI (JSON)
Cevabın SADECE aşağıdaki JSON formatında olmalı. Alanlar arasındaki farklara kesinlikle uy:

{
  "aiScore": number, // 1-10 arası puan (7 ve üzeri ONAY demektir)
  "aiApproved": boolean, // Puan >= 7 ise true, değilse false

  // KURAL 1: ANALİST ÖZETİ (Durum Tespiti)
  // Rakamları tekrar etme! Piyasanın ruh halini anlat.
  // Örn: "Satıcılar yoruldu, alıcılar tahtayı domine ediyor. Hype organik görünüyor."
  "analystSummary": "string",

  // KURAL 2: RİSK ANALİZİ (Tehlikeler)
  // ASLA strateji verme. Sadece 'Neyin ters gidebileceğini' yaz.
  // Örn: "Likidite market cap'e göre düşük, sert satış yerse toparlayamaz." veya "Twitter hype'ı tamamen bot, suni yükseliş."
  "riskAnalysis": "string",

  // KURAL 3: STRATEJİ (Eylem Planı)
  // ASLA riskten bahsetme. Sadece 'Ne yapmalı?' sorusuna emir kipiyle cevap ver.
  // Örn: "Hemen giriş yapma, %10 geri çekilme bekle." veya "Momentum çok güçlü, stop-loss koyarak market buy atılabilir."
  "strategy": "string",
  
  "headline": "Kısa, emoji içeren vurucu başlık"
}

# YASAKLI KELİMELER:
- "Momentum güçlü" ifadesini her yere kopyalama.
- Risk ve Strateji alanları ASLA aynı cümleyi içeremez.
`;
        const userContent = `
TOKEN: $${token.symbol} (${token.name})
AGE: ${ageHours.toFixed(1)} Hours
STATS: 
- MC: $${mc.toLocaleString()}
- Liq: $${liq.toLocaleString()} (Ratio: ${liqMcRatio})
- 24h Vol: $${vol.toLocaleString()}
- M5 Txns: ${buys5m} BUYS vs ${sells5m} SELLS (Total: ${txCount})

TWITTER DATA (${tweets.length} tweets found):
${hasTweets ? tweets.slice(0, 30).join('\n') : "NO TWITTER DATA AVAILABLE"}

GÖREV: Yukarıdaki kurallara göre analiz et ve JSON çıktısını üret.
`;

        return { systemPrompt, userContent };
    }

    private normalizeResult(result: any): AIAnalysisResult {
        // Map new JSON format to internal AIAnalysisResult interface
        const score = typeof result.aiScore === 'number' ? result.aiScore : 4;

        return {
            headline: result.headline || `⚠️ ANALYZING`,
            narrative: result.analystSummary || "No narrative generated.", // Analist Özeti -> Narrative
            analystSummary: result.analystSummary || "No summary.",
            technicalOutlook: result.analystSummary ? "AI Analyzed" : "No Data",
            socialVibe: "Twitter Data Analyzed",
            riskAnalysis: result.riskAnalysis || "Check Risk",
            strategy: result.strategy || "WATCH",
            analysis: [],
            riskLevel: 'HIGH', // Default to High for manual review
            riskReason: result.riskAnalysis || '', // Risk nedeni buraya
            score: score,
            isApproved: result.aiApproved === true,
            verdict: score >= 7 ? 'APE' : 'FADE',
            displayEmoji: score >= 7 ? '🚀' : '⚠️',
            recommendation: score >= 7 ? 'AL' : 'PAS',
            advice: result.strategy || '',
            vibe: result.headline || ''
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
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning", // Ultra Low Cost Model
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
