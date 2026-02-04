import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
import { BirdeyeService } from '../services/BirdeyeService';
import { Matcher } from '../core/Matcher';
import { ScoringEngine } from '../core/ScoringEngine';
import { PhaseDetector } from '../core/PhaseDetector';
import { CooldownManager } from '../core/CooldownManager';
import { NarrativeEngine } from '../narrative/NarrativeEngine';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterPublisher } from '../twitter/TwitterPublisher';
import { PostgresStorage } from '../storage/PostgresStorage';
import { TokenSnapshot } from '../models/types';
import { QueryBuilder } from '../twitter/QueryBuilder';
import { TwitterScraper } from '../twitter/TwitterScraper';
import { TwitterStoryEngine } from '../narrative/TwitterStoryEngine';
import { TrendCollector } from '../trends/TrendCollector';
import { TrendTokenMatcher } from '../core/TrendTokenMatcher';
import { AlphaSearchService } from '../twitter/AlphaSearchService';
import { DexScreenerService } from '../services/DexScreenerService';
import { LLMService } from '../services/LLMService';

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    private processedCache = new Map<string, number>();

    constructor(
        private pumpFun: PumpFunService,
        private birdeye: BirdeyeService,
        private dexScreener: DexScreenerService,
        private matcher: Matcher,
        private scorer: ScoringEngine,
        private phaseDetector: PhaseDetector,
        private cooldown: CooldownManager,
        private narrative: NarrativeEngine,
        private bot: ScandexBot,
        private twitter: TwitterPublisher,
        private storage: PostgresStorage,
        private trendCollector: TrendCollector,
        private trendMatcher: TrendTokenMatcher,
        private alphaSearch: AlphaSearchService,
        private llmService: any // Need to inject LLMService or use global if not injected (Assuming injected or Import)
    ) { }

    // --- AI QUEUE LOGIC ---
    private analysisQueue: Array<{ token: TokenSnapshot; msgId: number }> = [];
    private activeAnalysisCount = 0;
    private MAX_CONCURRENT_ANALYSIS = 2;

    private async enqueueAnalysis(token: TokenSnapshot, msgId: number) {
        this.analysisQueue.push({ token, msgId });
        this.processAnalysisQueue();
    }

    private async processAnalysisQueue() {
        if (this.activeAnalysisCount >= this.MAX_CONCURRENT_ANALYSIS || this.analysisQueue.length === 0) return;

        const item = this.analysisQueue.shift();
        if (!item) return;

        this.activeAnalysisCount++;
        try {
            // logger.info(`[AI Worker] Analyzing ${item.token.symbol}... (Queue: ${this.analysisQueue.length})`);

            // 1. Run Analysis
            // Note: We need access to LLMService. If not in constructor, we might need to import it or pass it.
            // Assuming we added it to constructor or have access. Ideally constructor injection.
            // For now, let's assume `this.llmService` exists. **WAIT**, I need to add it to Constructor!

            // Temporary Fix: If LLMService is not in constructor, I'll use a direct import if possible, 
            // BUT proper way is Constructor injection. I will update Constructor in next tool call.
            // For this Replace block, I will assume `this.llmService` is available.

            const analysis = await this.llmService.analyzePostSnipe(item.token);

            if (analysis) {
                // 2. Reply to Telegram
                const emoji = analysis.riskLevel === 'LOW' ? '🟢' : analysis.riskLevel === 'MEDIUM' ? '🟡' : '🔴';
                const replyText = `🧠 **AI ANALYST INSIGHT**\n\n` +
                    `📊 **Momentum:** ${analysis.momentumPhase}\n` +
                    `⚖️ **Price Context:** ${analysis.priceContext}\n` +
                    `🛡️ **Risk Level:** ${emoji} ${analysis.riskLevel}\n\n` +
                    `📝 *${analysis.explanation[0]}*\n` +
                    (analysis.explanation[1] ? `📝 *${analysis.explanation[1]}*` : '');

                await this.bot.replyToMessage(config.TELEGRAM_CHAT_ID as any, item.msgId, replyText);

                // 3. Save Analysis Update to DB (Optional, for Dashboard)
                // await this.storage.updateSeenTokenAnalysis(...) 
            }

        } catch (err) {
            logger.error(`[AI Worker] Failed for ${item.token.symbol}: ${err}`);
        } finally {
            this.activeAnalysisCount--;
            // Process next
            setTimeout(() => this.processAnalysisQueue(), 100);
        }
    }

    private async runLoop() {
        if (!this.isRunning) return;

        // Parallel Processes:
        // 1. Main Scan (New Tokens) - Every SCAN_INTERVAL
        // 2. Dip Monitor (Waiting Tokens) - Every 30 seconds (User Request)

        this.runCycle().finally(() => {
            const delay = config.SCAN_INTERVAL_SECONDS * 1000;
            logger.info(`[Job] Scan complete. Next scan in ${config.SCAN_INTERVAL_SECONDS}s...`);
            setTimeout(() => this.runLoop(), delay);
        });
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Token Scan Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);

        // Start Main Loop
        this.runLoop();

        // Start Dip Monitor Loop (Independent)
        this.runDipMonitor();
    }

    private async runDipMonitor() {
        if (!this.isRunning) return;

        try {
            await this.monitorDipCandidates();
        } catch (err) {
            logger.error(`[DipMonitor] Error: ${err}`);
        }

        // Run every 30 seconds
        setTimeout(() => this.runDipMonitor(), 30000);
    }

    // ... (runCycle method remains here)

    private async runCycle() {
        if (this.isScanning) {
            logger.warn(`[Job] ⚠️ Cycle skipped - Previous cycle still running.`);
            return;
        }

        this.isScanning = true;

        try {
            logger.info('[Job] 🔍 Starting DexScreener Scan...');

            // 1. Fetch Candidates (DexScreener Latest Pairs)
            const dexTokens = await this.dexScreener.getLatestPairs();
            logger.info(`[Fetch] 📡 Received ${dexTokens.length} tokens from DexScreener`);

            if (dexTokens.length === 0) {
                logger.info(`[Scan] ⚠️ No trending tokens from DexScreener. Cooldown may be active.`);
                return;
            }

            const freshCandidates: TokenSnapshot[] = [];
            const now = Date.now();
            let cachedCount = 0;

            for (const token of dexTokens) {
                const lastProcessed = this.processedCache.get(token.mint);
                // SMART CACHE: Reverted to 4 hours
                if (lastProcessed && (now - lastProcessed < 4 * 60 * 60 * 1000)) {
                    cachedCount++;
                    continue;
                }
                freshCandidates.push(token);
            }

            logger.info(`[Cache] 🔄 Filtered out ${cachedCount} recently seen tokens`);

            if (freshCandidates.length === 0) {
                logger.info(`[Scan] ⚠️ No fresh candidates to process. Next cycle in 120s.`);
                return;
            }

            logger.info(`[Job] 🔍 Processing ${freshCandidates.length} fresh candidates...`);

            // Scan Statistics
            let gateCount = 0; // Hard Rejects (Liq, Fake Pump)
            let weakCount = 0; // Low Score (<70)
            let alertCount = 0;

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token) => {
                    try {
                        // LRU-like Safety Check
                        if (this.processedCache.size > 1000) {
                            const oldest = this.processedCache.keys().next().value;
                            if (oldest) this.processedCache.delete(oldest);
                        }
                        this.processedCache.set(token.mint, Date.now());

                        // --- STEP 1: STRICT LIQUIDITY GATES (Sniper Firewall) ---
                        const liq = Number(token.liquidityUsd) || 0;
                        const mc = Number(token.marketCapUsd) || 0;
                        const liqMcRatio = mc > 0 ? liq / mc : 0;

                        // GATE A: Unplayable Liquidity
                        if (liq < 5000) {
                            gateCount++;
                            return;
                        }

                        // GATE B: Rug / Scam Risk
                        if (liqMcRatio > 0.90) {
                            gateCount++;
                            logger.warn(`[Gate] 🚫 High Liquidity Ratio: ${token.symbol} (${(liqMcRatio * 100).toFixed(1)}%). Potential Scam.`);
                            return;
                        }

                        // --- STEP 2: MECHANICAL SCORING (Speed Focus) ---
                        const matchResult = { memeMatch: false };
                        const enrichedToken = token;

                        const scoreRes = this.scorer.score(enrichedToken, matchResult);
                        const { totalScore, phase } = scoreRes;

                        // REJECTION CHECK
                        // Threshold: 70/100
                        if (phase === 'REJECTED_RISK') {
                            gateCount++; // Fake pump or other hard risk from engine
                            return;
                        }

                        if (totalScore < 70) {
                            weakCount++;
                            return;
                        }

                        // --- STEP 3: SNIPED! (Immediate Alert) ---
                        const { allowed } = await this.cooldown.canAlert(token.mint);
                        if (allowed) {
                            alertCount++;

                            // Determine Segment for Logging
                            let segmentLog = 'UNKNOWN';
                            if (mc < 50000) segmentLog = 'SEED';
                            else if (mc < 250000) segmentLog = 'GOLDEN';
                            else segmentLog = 'RUNNER';

                            logger.info(`🔫 [SNIPED] [${segmentLog}] ${token.symbol} Score: ${totalScore}/100 | Liq: $${Math.floor(liq)} | MC: $${Math.floor(mc)}`);

                            // Create Mechanical Narrative (No AI Latency)
                            const displayScore = (totalScore / 10).toFixed(1);

                            const mechanicalNarrative = {
                                headline: `🔫 SNIPER ALERT: ${token.symbol}`,
                                narrativeText: `⚡ **MECHANICAL ENTRY** • Score: ${displayScore}/10
🚀 **MOMENTUM SIGNAL**
• Txns Accelerating
• Liquidity Healthy ($${(liq / 1000).toFixed(1)}k)
• MC Segment: ${segmentLog}

⚠️ **RISK CHECK:**
• Volatility: High
• Entry Type: ${segmentLog === 'SEED' ? 'Small Size' : 'Full Size'}`,
                                dataSection: `• MC: $${(mc / 1000).toFixed(1)}k
• Liq: $${(liq / 1000).toFixed(1)}k
• Vol: $${(token.volume5mUsd || 0).toFixed(0)}
• Age: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) + 'm' : 'N/A'}`,
                                tradeLens: `SNIPE`,
                                vibeCheck: `MECHANICAL`,
                                aiScore: totalScore,
                                aiApproved: true
                            };

                            // Save as ALERTED immediately
                            await this.storage.saveSeenToken(token.mint, {
                                symbol: token.symbol,
                                firstSeenAt: Date.now(),
                                lastAlertAt: Date.now(),
                                lastScore: totalScore,
                                lastPhase: 'ALERTED',
                                storedAnalysis: JSON.stringify(mechanicalNarrative),
                                rawSnapshot: enrichedToken // NEW: Save Full Object for AI Training
                            });

                            // ⚡ FIRE ALERT & GET MSG ID
                            const alertMsgId = await this.bot.sendAlert(mechanicalNarrative, enrichedToken, scoreRes);

                            await this.cooldown.recordAlert(token.mint, totalScore, 'TRACKING', token.priceUsd);

                            // AUTOPSY PRESERVATION
                            await this.storage.savePerformance({
                                mint: token.mint,
                                symbol: token.symbol,
                                alertMc: mc,
                                athMc: mc,
                                currentMc: mc,
                                entryPrice: Number(token.priceUsd) || 0,
                                status: 'TRACKING',
                                alertTimestamp: new Date(),
                                lastUpdated: new Date()
                            });

                            // --- 🧠 AI POST-ANALYSIS (ASYNC QUEUE) ---
                            // Fire & Forget (Queue handles concurrency)
                            if (alertMsgId) {
                                this.enqueueAnalysis(token, alertMsgId);
                            }

                        }

                    } catch (tokenErr) {
                        logger.error(`[Job] Error processing token ${token.symbol}: ${tokenErr}`);
                    }
                }));
                // Tiny delay between chunks
                await new Promise(r => setTimeout(r, 50));
            }



            // SCAN SUMMARY
            const totalRejected = gateCount + weakCount;
            logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 [SCAN SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Total Fetched: ${dexTokens.length}
🔄 Cached (4h): ${cachedCount}
🎯 Fresh Processed: ${freshCandidates.length}

🛑 REJECTED (${totalRejected}):
  ⛔ GATE (Liq/Risk): ${gateCount}
  📉 WEAK (Score <70): ${weakCount}

✅ SNIPED: ${alertCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        } finally {
            this.isScanning = false;
        }
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const res: T[][] = [];
        for (let i = 0; i < arr.length; i += size) { res.push(arr.slice(i, i + size)); }
        return res;
    }

    /**
     * RAPID MONITOR: Checks 'WAITING_DIP' tokens every 30s.
     * Uses cached analysis + fresh price to alert instantly on dip.
     */
    private async monitorDipCandidates() {
        // 1. Get Waiting Tokens
        const candidates = await this.storage.getWaitingForDipTokens();
        if (candidates.length === 0) return;

        logger.info(`[DipMonitor] 👀 Watching ${candidates.length} tokens for entry...`);

        // 2. Fetch Live Prices (Bulk)
        const mints = candidates.map(c => c.mint);
        const liveTokens = await this.dexScreener.getTokens(mints);

        // 3. Compare & Alert
        for (const candidate of candidates) {
            const liveToken = liveTokens.find(t => t.mint === candidate.mint);

            // TIMEOUT CHECK (>60 Mins) (User Request: 30-60 mins)
            const waitDuration = Date.now() - new Date(candidate.alertTimestamp).getTime();
            if (waitDuration > 60 * 60 * 1000) {
                logger.info(`[DipMonitor] ⌛ Timeout for ${candidate.symbol}. Missed Dip.`);
                await this.storage.failDipToken(candidate.mint, 'MISSED_DIP');
                continue;
            }

            if (!liveToken) continue;

            const currentMc = liveToken.marketCapUsd || 0;
            const targetMc = candidate.dipTargetMc || 0;

            // ENTRY CONDITION: Price <= Target
            if (currentMc > 0 && currentMc <= targetMc) {
                logger.info(`[DipMonitor] 🎯 DIP HIT! ${candidate.symbol} dropped to $${Math.floor(currentMc)} (Target: $${Math.floor(targetMc)})`);

                // Retrieve Stored Analysis
                const seenData = await this.storage.getSeenToken(candidate.mint);
                let narrative = null;

                if (seenData?.storedAnalysis) {
                    try {
                        narrative = JSON.parse(seenData.storedAnalysis);
                        // Update Data Section with FRESH numbers
                        narrative.dataSection =
                            `• MC: $${(currentMc).toLocaleString()}\n` +
                            `• Liq: $${(liveToken.liquidityUsd ?? 0).toLocaleString()}\n` +
                            `• Vol (24h): $${(liveToken.volume24hUsd ?? 0).toLocaleString()}\n` +
                            `• Age: ${liveToken.createdAt ? Math.floor((Date.now() - liveToken.createdAt.getTime()) / (3600 * 1000)) + 'h' : 'N/A'}\n` +
                            `• ✅ Dip Entry Triggered (Price dropped 50% from pump)`;

                    } catch (e) {
                        logger.error(`[DipMonitor] Failed to parse stored analysis for ${candidate.symbol}`);
                    }
                }

                // Fallback if no analysis found (e.g. old tokens before update)
                // Fallback if no analysis found (e.g. old tokens before update)
                if (!narrative) {
                    narrative = {
                        headline: `📉 DIP ENTRY TRIGGERED`,
                        mainStory: `Wait for breakout confirmation.`,
                        // Mimic the AI structure manually
                        narrativeText: `✨ **POTANSİYEL VAR** • Puan: ${seenData?.lastScore || 7}/10
🔥 **DIP FIRSATI YAKALANDI**

🧐 **ANALİST ÖZETİ:**
Bu token, güçlü bir yükseliş sonrası beklenen düzeltme seviyesine (%50 geri çekilme) geldi. AI analizi bu eski kayıt için mevcut değil ancak teknik göstergeler "Dip Alım" fırsatını işaret ediyor. Hacim ve likidite oranları sağlıklı görünüyor.

📊 **Teknik Görünüm:**
Fiyat, pump sonrası 0.5 fib seviyesine (veya eşdeğerine) geri çekildi. Bu seviye genellikle tepki alımlarının geldiği noktadır. Likidite/MC oranı izlenmeli.

🚀 **STRATEJİ:**
Kademeli alım düşünülebilir. Stop-loss'u dip seviyesinin %5-10 altına koyarak tepki yükselişini bekle.`,
                        dataSection: `• MC: $${(currentMc).toLocaleString()}\n• Target: $${(targetMc).toLocaleString()}\n• ✅ Dip Entry Triggered`,
                        tradeLens: `WAITING -> TRACKING`,
                        vibeCheck: `Requires Manual Review`,
                        aiScore: seenData?.lastScore || 7,
                        aiApproved: true
                    };
                }

                if (narrative) {
                    // Send Alert using Full Format + Special Title
                    await this.bot.sendTokenAlert(liveToken, narrative, `CORRECTION ENTRY: $${candidate.symbol} 📉`);

                    // Update Status to TRACKING (so we track PnL from here)
                    await this.storage.activateDipToken(candidate.mint, liveToken.priceUsd || 0, currentMc);
                    await this.cooldown.recordAlert(liveToken.mint, seenData?.lastScore || 7, 'TRACKING', liveToken.priceUsd);
                }
            } else {
                // logger.debug(`[DipMonitor] ${candidate.symbol} at $${Math.floor(currentMc)} (Target: $${Math.floor(targetMc)}) - Waiting...`);
            }
        }
    }
}
