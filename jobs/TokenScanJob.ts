import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
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
import { GoPlusService } from '../services/GoPlusService';
import { LLMService } from '../services/LLMService';

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    // SMART CACHE: TTL Support
    private processedCache = new Map<string, { blockedUntil: number | null, reason: string }>();

    // RETRY SETTINGS (Time in ms)
    private static CACHE_TTL: Record<string, number | null> = {
        'Too Young': 15 * 60 * 1000,           // 15 mins (threshold is 20min)
        'Weak Score': 20 * 60 * 1000,          // 20 mins
        'Low Liq Ratio': 30 * 60 * 1000,       // 30 mins
        'Twitter Fail': 15 * 60 * 1000,        // 15 mins (AI might improve with more data)
        'No Twitter Data': 20 * 60 * 1000,     // 20 mins (new token needs time)
        'GoPlus Failed': 10 * 60 * 1000,     // 10 mins (was RugCheck)
        // Others are Permanent (null)
    };

    private getTTL(reason: string, token: TokenSnapshot): number | null {
        // TEMPORARY BLOCKS (Will Retry)
        if (reason.includes('Too Young')) return 10 * 60 * 1000;  // 10 mins
        if (reason.includes('Weak Score')) return 30 * 60 * 1000; // 30 mins
        if (reason.includes('Low Liq Ratio') && !reason.includes('Extreme') && !reason.includes('<5%')) {
            return 60 * 60 * 1000; // 1 hour (liquidity might improve)
        }
        if (reason.includes('Twitter Fail')) return 15 * 60 * 1000;
        if (reason.includes('No Twitter Data')) return 20 * 60 * 1000;
        if (reason.includes('GoPlus') || reason.includes('RugCheck')) return 10 * 60 * 1000;
        if (reason.includes('Low Liquidity')) return 120 * 60 * 1000; // 2 hours (liquidity can be added)
        if (reason.includes('Risk Engine') || reason.includes('Fake Pump')) return 30 * 60 * 1000; // 30 mins (spike might normalize)

        // SMART RETRY: Bot Risk (Holders < 50)
        // If the token is NEW (< 2 hours), give it 30 mins to grow community
        if (reason.includes('Bot Risk')) {
            // If createdAt is missing, we assume it's new (better to retry once than block forever)
            const createdAt = token.createdAt ? new Date(token.createdAt).getTime() : Date.now();
            const ageMs = Date.now() - createdAt;
            const twoHours = 2 * 60 * 60 * 1000;

            if (ageMs < twoHours) {
                return 30 * 60 * 1000; // Retry in 30 mins
            }
            return null; // Permanent if > 2h and still < 50 holders
        }

        // PERMANENT BLOCKS (structural issues that won't fix themselves)
        if (reason.includes('Too Old')) return null;           // >168h won't get younger
        if (reason.includes('Whale Risk')) return null;        // Top10 concentration stable
        if (reason.includes('High Liq Ratio')) return null;    // >90% locked liquidity
        if (reason.includes('Extreme') || reason.includes('Liq Ratio <5%')) return null;
        if (reason.includes('BLACKLIST')) return null;

        // Unknown reasons: default to PERMANENT (safety)
        logger.warn(`[Cache] ⚠️ Unknown rejection: "${reason}". Defaulting to PERMANENT.`);
        return null;
    }

    private cleanupExpiredCache() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [mint, data] of this.processedCache.entries()) {
            if (data.blockedUntil && data.blockedUntil < now) {
                this.processedCache.delete(mint);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            logger.info(`[Cache] 🧹 Cleaned ${cleanedCount} expired entries (Ready for retry)`);
        }
    }

    constructor(
        private pumpFun: PumpFunService,
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
        private llmService: LLMService,
        private goPlus: GoPlusService // NEW: Injected
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
                // 2. Reply to Telegram (DISABLED by User Request - Background Save Only)
                /*
                const emoji = analysis.riskLevel === 'LOW' ? '🟢' : analysis.riskLevel === 'MEDIUM' ? '🟡' : '🔴';
                const replyText = `🧠 **AI ANALYST INSIGHT**\n\n` +
                    `📊 **Momentum:** ${analysis.momentumPhase}\n` +
                    `⚖️ **Price Context:** ${analysis.priceContext}\n` +
                    `🛡️ **Risk Level:** ${emoji} ${analysis.riskLevel}\n\n` +
                    `📝 *${analysis.explanation[0]}*\n` +
                    (analysis.explanation[1] ? `📝 *${analysis.explanation[1]}*` : '');
    
                await this.bot.replyToMessage(config.TELEGRAM_CHAT_ID as any, item.msgId, replyText);
                */

                // 3. Save Analysis Update to DB (Background)
                logger.info(`[AI Worker] 🧠 Saving Analysis for ${item.token.symbol} (Silent Mode)`);
                await this.storage.updateStoredAnalysis(item.token.mint, JSON.stringify(analysis));
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
        // this.runDipMonitor(); // DISABLED per user request
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

        // Cache Maintenance
        this.cleanupExpiredCache();

        this.isScanning = true;

        try {
            logger.info('[Job] 🔍 Starting DexScreener Scan...');

            // 1. Fetch Candidates (DexScreener only for speed/cost)
            const dexTokens = await this.dexScreener.getLatestPairs();

            // 3. Merge & Deduplicate (Ensure uniqueness by Mint Address)
            const uniqueTokens = Array.from(
                new Map(dexTokens.map(t => [t.mint, t])).values()
            );

            logger.info(`[Fetch] 📡 Total: ${uniqueTokens.length} (DexScreener)`);

            if (uniqueTokens.length === 0) {
                logger.info(`[Scan] ⚠️ No trending tokens found.`);
                return;
            }

            const freshCandidates: TokenSnapshot[] = [];
            const now = Date.now();
            let cachedCount = 0;
            let retryCount = 0;

            for (const token of uniqueTokens) {
                const cacheData = this.processedCache.get(token.mint);

                if (cacheData) {
                    const isExpired = cacheData.blockedUntil && cacheData.blockedUntil < now;

                    // ⬇️ HER TOKEN İÇİN LOG - User Requested Debug
                    logger.debug(`[Cache] ${token.symbol}: blocked=${cacheData.blockedUntil}, now=${now}, expired=${isExpired}`);

                    if (isExpired) {
                        logger.info(`[Cache] ✅ ${token.symbol} EXPIRED! (Reason: ${cacheData.reason})`);
                        retryCount++;
                        this.processedCache.delete(token.mint);
                        // Fall through to processed below
                    } else {
                        // Still blocked (Permanent or TTL future)
                        cachedCount++;
                        continue;
                    }
                }

                // If we are here, token is either fresh OR retired/expired from cache
                freshCandidates.push(token);
            }

            logger.info(`[Cache] 🔄 Filtered ${cachedCount} seen tokens. Retrying ${retryCount} expired tokens.`);

            if (freshCandidates.length === 0) {
                logger.info(`[Scan] ⚠️ No fresh candidates to process. Next cycle in 120s.`);
                return;
            }

            logger.info(`[Job] 🔍 Processing ${freshCandidates.length} candidates...`);

            // Scan Statistics
            let gateCount = 0; // Hard Rejects (Liq, Fake Pump)
            let weakCount = 0; // Low Score (<70)
            let alertCount = 0;
            const rejectionReasons: Record<string, number> = {};

            // Helper to handle rejection with TTL
            const handleRejection = (token: TokenSnapshot, reason: string) => {
                rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;

                const ttl = this.getTTL(reason, token);
                const blockedUntil = ttl === null ? null : Date.now() + ttl;

                this.processedCache.set(token.mint, {
                    reason,
                    blockedUntil
                });

                // Detailed Log for Retries
                if (blockedUntil) {
                    const mins = Math.ceil(ttl! / 60000);
                    logger.info(`[REJECT] ${token.symbol} -> ${reason} (Retry in ${mins}m)`);
                } else {
                    logger.info(`[REJECT] ${token.symbol} -> ${reason} (Permanent)`);
                }
            };

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token, i) => {
                    try {
                        // LRU Safety Check
                        if (this.processedCache.size > 1000) {
                            const oldest = this.processedCache.keys().next().value;
                            if (oldest) this.processedCache.delete(oldest);
                        }

                        // Mark as currently processing (Short TTL in case of crash)
                        // If it passes, we will update or remove this? 
                        // Actually, if it passes, we don't add to processedCache yet? 
                        // NO, we MUST add to processedCache to avoid double processing in next cycle if it takes long.
                        // Let's set a temporary "Processing" state.
                        // For simplicity, we only cache REJECTIONS. Passed tokens are handled by "seen_tokens" DB check potentially?
                        // Wait, previous logic was: processedCache.set(token.mint, Date.now()) -> Permanent block.
                        // So if we pass, we should also cache it to avoid reprocessing.
                        // Passed tokens: Permanent Block (until restart?) or maybe 1 hour?
                        // Let's stick to simple: If passed, cached as "Processed" (Permanent for this session).
                        // NOTE: We only cache rejections via handleRejection.
                        // If we don't cache here, it might be processed again immediately?
                        // Yes, so we need initial cache.
                        // Initial Cache: Block for 5 mins (Processing)
                        // Processing Cache Logic REMOVED per user request
                        // No initial cache set - only rejections are cached.

                        // --- STEP 1: STRICT LIQUIDITY GATES (Sniper Firewall) ---

                        const liq = Number(token.liquidityUsd) || 0;
                        const mc = Number(token.marketCapUsd) || 0;
                        const liqMcRatio = mc > 0 ? liq / mc : 0;
                        const ageMins = token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) : 0;

                        // GATE 0: BLACKLIST (HARD BLOCK - BEFORE EVERYTHING)
                        const BLACKLIST = ['pedo', 'child', 'nazi', 'jew', 'hitler', 'rape', 'terrorist', 'kill'];
                        const tokenText = (token.name + ' ' + token.symbol).toLowerCase();
                        if (BLACKLIST.some(word => tokenText.includes(word))) {
                            logger.warn(`[Gate] ⛔ BLACKLIST: ${token.symbol} contains banned word`);
                            gateCount++;
                            handleRejection(token, 'BLACKLIST');
                            logger.info(`[REJECT] ${token.symbol} -> BLACKLIST`);
                            return;
                        }

                        // GATE A: Unplayable Liquidity
                        if (liq < 5000) {
                            gateCount++;
                            handleRejection(token, 'Low Liquidity (<$5k)');
                            logger.info(`[REJECT] ${token.symbol} -> Low Liquidity ($${Math.floor(liq)})`);
                            return;
                        }

                        // GATE B: Rug / Scam Risk
                        // > 90%: Likely HoneyPot (Dev adds all liq)
                        // < 15%: Unstable / Slippage Hell
                        if (liqMcRatio > 0.90) {
                            gateCount++;
                            logger.warn(`[Gate] 🚫 High Liquidity Ratio: ${token.symbol} (${(liqMcRatio * 100).toFixed(1)}%). Potential Scam.`);
                            handleRejection(token, 'High Liq Ratio (>90%)');
                            logger.info(`[REJECT] ${token.symbol} -> High Liq Ratio (${(liqMcRatio * 100).toFixed(0)}%)`);
                            return;
                        }
                        // NUANCED LIQ RATIO: Combine percentage with absolute liquidity
                        if (liqMcRatio < 0.05) {
                            // <5%: Always reject (extreme volatility)
                            gateCount++;
                            handleRejection(token, 'Liq Ratio <5% (Extreme)');
                            logger.info(`[REJECT] ${token.symbol} -> Liq Ratio <5% (${(liqMcRatio * 100).toFixed(1)}%)`);
                            return;
                        }
                        if (liqMcRatio >= 0.05 && liqMcRatio < 0.10 && liq < 20000) {
                            // 5-10% + low absolute liquidity: Reject
                            gateCount++;
                            handleRejection(token, 'Low Liq Ratio + Low Absolute Liq');
                            logger.info(`[REJECT] ${token.symbol} -> Liq ${(liqMcRatio * 100).toFixed(1)}% + $${Math.floor(liq / 1000)}k`);
                            return;
                        }
                        // 5-10% + $20k+ liquidity: Pass
                        // >10%: Pass

                        // GATE C: Age Filter (The "Golden Window")
                        // USER REQUEST: Min Age 20 mins
                        if (ageMins < 20) {
                            gateCount++;
                            handleRejection(token, 'Too Young (<20m)');
                            logger.info(`[REJECT] ${token.symbol} -> Too Young (${ageMins}m)`);
                            return;
                        }

                        // --- STEP 2: MECHANICAL SCORING (Speed Focus) ---
                        const matchResult = { memeMatch: false };
                        let enrichedToken = token; // Mutable for enrichment

                        const scoreRes = this.scorer.score(enrichedToken, matchResult);
                        let { totalScore, phase } = scoreRes;

                        // --- AGE SCORE ADJUSTMENTS (User Requested) ---
                        // 0 - 4 Hours: +10 Points (Reward)
                        // 24 - 48 Hours: -5 Points
                        // 48 - 96 Hours: -10 Points
                        // 96 - 168 Hours: -15 Points
                        // > 168 Hours (7 Days): -30 Points (No Rejection anymore)

                        let ageAdjustment = 0;
                        const hours = ageMins / 60;

                        if (hours <= 4) {
                            ageAdjustment = 10; // Reward
                        } else if (hours >= 24 && hours < 48) {
                            ageAdjustment = -5;
                        } else if (hours >= 48 && hours < 96) {
                            ageAdjustment = -10;
                        } else if (hours >= 96 && hours < 168) {
                            ageAdjustment = -15;
                        } else if (hours >= 168) {
                            ageAdjustment = -30;
                        }

                        const originalScore = totalScore;
                        totalScore += ageAdjustment;
                        // Clamp score to reasonable bounds (0 to 130 theoretically)
                        if (totalScore < 0) totalScore = 0;

                        if (ageAdjustment !== 0) {
                            const sign = ageAdjustment > 0 ? '+' : '';
                            logger.info(`[Age Adjust] ${token.symbol}: ${originalScore} -> ${totalScore} (${sign}${ageAdjustment} pts, Age: ${hours.toFixed(1)}h)`);
                        }

                        // REJECTION CHECK
                        // Threshold: 40/100 (TEST MODE - LOW THRESHOLD)
                        if (phase === 'REJECTED_RISK') {
                            gateCount++; // Fake pump or other hard risk from engine
                            handleRejection(token, 'Risk Engine (Fake Pump)');
                            logger.info(`[REJECT] ${token.symbol} -> Risk Engine (Fake Pump/Dump)`);
                            return;
                        }

                        if (totalScore < 40) {
                            weakCount++;
                            handleRejection(token, 'Weak Score');
                            logger.info(`[REJECT] ${token.symbol} -> Weak Score (${totalScore}/100)`);
                            return;
                        }


                        // --- STEP 3: SECURITY & HOLDER CHECK (DexScreener Internal API - Unified) ---
                        // Replaces Birdeye and RPC for Security, Liquidity, and Holders
                        let holderCount = -1;
                        let top10Percent = 0;
                        let isMintable = false;
                        let isFreezable = false;
                        let burnedLiquidity = 0;
                        let holderSource = 'UNKNOWN';

                        // BURST PREVENTION: If many tokens, add a significant delay to respect limits
                        if (i > 0) await new Promise(res => setTimeout(res, 800));

                        try {
                            if (token.pairAddress) {
                                const dexData = await this.dexScreener.getPairDetails(token.pairAddress);
                                if (dexData) {
                                    // 1. Holder Data
                                    if (dexData.holderCount !== undefined && dexData.holderCount !== null) {
                                        holderCount = dexData.holderCount;
                                        top10Percent = dexData.top10Percent;
                                        holderSource = 'DexInternal';
                                    }

                                    // 2. Security Flags
                                    isMintable = dexData.security.isMintable;
                                    isFreezable = dexData.security.isFreezable;

                                    // 3. Liquidity Data
                                    burnedLiquidity = dexData.liquidity.burnedPercent;

                                    logger.info(`[DexInternal] 🟢 ${token.symbol}: ${holderCount} Holders, Top10: ${top10Percent.toFixed(1)}%, Mint:${isMintable}, Burned:${burnedLiquidity}%`);
                                }
                            }

                            // FALLBACK: If internal API failed to return holders, try activity estimation? 
                            // User said "DexScreener is enough", so we trust it. 
                            // If it's missing, it's missing.

                        } catch (err: any) {
                            logger.error(`[HolderVerify] Critical Error: ${err.message}`);
                        }

                        // --- GATE D: SECURITY CHECKS (Unified) ---
                        // 1. Mintable / Freezable Check
                        // DexScreener gives us some flags. GoPlus gives us more.
                        // We run comprehensive GoPlus check here or earlier?
                        // Let's run GoPlus now for filtering.
                        const security = await this.checkRugSecurity(token.mint);
                        if (!security.safe) {
                            gateCount++;
                            handleRejection(token, security.reason || 'Security Risk');
                            logger.info(`[REJECT] ${token.symbol} -> ${security.reason}`);
                            return;
                        }

                        // 2. Rug Check (Burned Liquidity) - Replaces Ownership Check
                        // DexScreener liquidity data fallback
                        if (burnedLiquidity < 80 && burnedLiquidity > 0) { // If 0, might be unknown. If > 0 but < 80, risky.
                            logger.warn(`[Gate] 🔓 Low Burned Liquidity: ${token.symbol} (${burnedLiquidity}%)`);
                            // gateCount++; // Soft warn for now
                        }

                        enrichedToken.holderCount = holderCount;
                        enrichedToken.top10HoldersSupply = top10Percent;

                        // Tag source for debugging
                        logger.info(`[HolderVerify] Source: ${holderSource} | Count: ${holderCount}`);


                        // --- DYNAMIC THRESHOLDS (Time-Based) ---
                        const createdAt = token.createdAt ? token.createdAt.getTime() : Date.now();
                        const ageMinutes = (Date.now() - createdAt) / 60000;
                        let minHolders = 50; // Default

                        if (ageMinutes < 15) {
                            minHolders = 5; // Very new, just need existence
                        } else if (ageMinutes < 60) {
                            minHolders = 20; // Ramp up
                        }

                        // Special Case: < 30 mins and STILL no data (0 holders)
                        if (holderCount === 0 && ageMinutes < 30) {
                            logger.warn(`[Gate] ⚠️ No holder data for ${token.symbol} (${ageMinutes.toFixed(0)}m). Skipping gate with penalty.`);
                            // We allow it to proceed with a penalty implicitly (just don't reject)
                            totalScore -= 5;
                        } else {
                            // Standard Gate Logic
                            if (holderCount < minHolders) {
                                logger.info(`[Gate] 🤖 Bot Risk: ${token.symbol} (Holders: ${holderCount} < ${minHolders}) [Age: ${ageMinutes.toFixed(0)}m]`);
                                gateCount++;
                                handleRejection(token, `Bot Risk (Holders < ${minHolders})`);
                                logger.info(`[REJECT] ${token.symbol} -> Bot Risk (Holders ${holderCount})`);
                                return;
                            }
                        }

                        if (top10Percent > 50) {
                            logger.info(`[Gate] 🐋 Whale Risk: ${token.symbol} (Top 10: ${top10Percent.toFixed(1)}%)`);
                            gateCount++;
                            handleRejection(token, 'Whale Risk (Top10 >50%)');
                            logger.info(`[REJECT] ${token.symbol} -> Whale Risk (${top10Percent.toFixed(0)}%)`);
                            return;
                        }

                        // --- STEP 2.5: TWITTER AI SCORING (Social Phase) ---
                        // Only for tokens that passed Technical + Holder Analysis
                        logger.info(`[Stage 2] ${token.symbol} passed technical & risk (Score: ${totalScore}/100, Holders: ${enrichedToken.holderCount}). Fetching Twitter context...`);

                        let twitterScore = 0;
                        let aiReasoning = 'No Twitter analysis';
                        let tweets: any[] = []; // Define in outer scope for reuse

                        try {
                            // Fetch 50 tweets for better sample
                            const alphaResult = await this.alphaSearch.checkAlpha(token.symbol, token.mint);
                            tweets = alphaResult.tweets || [];

                            if (tweets.length === 0) {
                                logger.warn(`[Twitter AI] ${token.symbol}: No tweets found. Proceeding without social data.`);
                                aiReasoning = 'No social presence detected';
                            } else {
                                // AI Vibe Scoring (-100 to +100)
                                const aiScore = await this.llmService.scoreTwitterSentiment(enrichedToken, tweets);

                                if (aiScore) {
                                    // Use raw Vibe Score (Checklist Points + AI Discretion)
                                    twitterScore = aiScore.vibeScore;

                                    if (twitterScore < 0) {
                                        logger.warn(`[AI Audit] 🛑 NEGATIVE TWITTER VIBE: ${token.symbol} (Score: ${twitterScore})`);
                                    } else if (twitterScore > 0) {
                                        logger.info(`[AI Audit] ✨ POSITIVE TWITTER VIBE: ${token.symbol} (Score: +${twitterScore})`);
                                    }

                                    aiReasoning = aiScore.reasoning;

                                    if (aiScore.redFlags && aiScore.redFlags.length > 0) {
                                        logger.warn(`[Twitter AI] ${token.symbol} Red Flags: ${aiScore.redFlags.join(', ')}`);
                                    }
                                } else {
                                    logger.warn(`[Twitter AI] ${token.symbol}: Analysis failed.`);
                                    aiReasoning = 'AI unavailable';
                                }
                            }

                        } catch (twitterErr: any) {
                            logger.error(`[Twitter AI] Error for ${token.symbol}: ${twitterErr.message}. Proceeding without social data.`);
                            aiReasoning = 'Twitter fetch failed';
                        }

                        // Log final score combination
                        const combinedScore = totalScore + twitterScore;
                        logger.info(`[Combined Score] ${token.symbol}: Technical ${totalScore} + Vibe ${twitterScore.toFixed(1)} = ${combinedScore.toFixed(1)}/130`);


                        // --- STEP 3: SCORE GATE & ALERT ---(
                        // User Request: "Don't share anything below 7"
                        if (combinedScore < 70) {
                            logger.info(`[Gate] 📉 Low Score: ${token.symbol} (${combinedScore}/130) < 70. Rejecting.`);
                            handleRejection(token, `Weak Score (${combinedScore})`);
                            return;
                        }

                        const { allowed, reason } = await this.cooldown.canAlert(token.mint, combinedScore);
                        if (!allowed) {
                            logger.info(`[Cooldown] ⏳ ${token.symbol} is blocked: ${reason}. Skipping SNIPE.`);
                            return;
                        }

                        if (allowed) {
                            alertCount++;

                            // Determine Segment for Logging
                            let segmentLog = 'UNKNOWN';
                            if (mc < 50000) segmentLog = 'SEED';
                            else if (mc < 250000) segmentLog = 'GOLDEN';
                            else segmentLog = 'RUNNER';

                            logger.info(`🔫 [SNIPED] [${segmentLog}] ${token.symbol} Score: ${combinedScore}/130 | Liq: $${Math.floor(liq)} | MC: $${Math.floor(mc)}`);

                            // --- 🧠 AI SYNTHESIS (User Request: Contextual Analysis) ---
                            // 1. REUSE Tweets (Optimization: Don't fetch again!)
                            let tweetContext = tweets;
                            if (!tweetContext || tweetContext.length === 0) {
                                logger.warn(`[Scan] ⚠️ No tweets available for AI context.`);
                            } else {
                                logger.info(`[Scan] 🧠 Generating AI Analysis with ${tweetContext.length} tweets...`);
                            }

                            // 2. Run AI Analysis
                            let aiAnalysis: any = null;
                            try {
                                aiAnalysis = await this.llmService.analyzePostSnipe(enrichedToken, tweetContext);
                            } catch (e) {
                                logger.warn(`[Scan] ⚠️ AI Analysis failed: ${e}`);
                            }

                            // Create Narrative (Enriched with AI)
                            // Use Combined Score for Display (normalized to 10 for readability)
                            const displayScore = (combinedScore / 10).toFixed(1);
                            const aiSummary = aiAnalysis?.socialSummary ? `\n\n🧠 **AI VIBE:**\n${aiAnalysis.socialSummary}` : '';
                            const riskBadge = aiAnalysis?.riskLevel ? ` • Risk: ${aiAnalysis.riskLevel}` : '';


                            const mechanicalNarrative = {
                                headline: `🔫 SNIPER ALERT: ${token.symbol} ${riskBadge}`,
                                narrativeText: `⚡ **MECHANICAL ENTRY** • Score: ${displayScore}/10
🚀 **MOMENTUM SIGNAL**
• Txns Accelerating
• Liquidity Healthy ($${(liq / 1000).toFixed(1)}k)
• MC Segment: ${segmentLog}${aiSummary}

⚠️ **RISK CHECK:**
• Volatility: High
• Entry Type: ${segmentLog === 'SEED' ? 'Small Size' : 'Full Size'}
• Phase: ${aiAnalysis?.momentumPhase || 'Unknown'}`,
                                dataSection: `• MC: $${(mc / 1000).toFixed(1)}k
• Liq: $${(liq / 1000).toFixed(1)}k
• Vol: $${(token.volume5mUsd || 0).toFixed(0)}
• Age: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) + 'm' : 'N/A'}`,
                                tradeLens: `SNIPE`,
                                vibeCheck: aiAnalysis?.riskLevel ? `Risk: ${aiAnalysis.riskLevel}` : `MECHANICAL`,
                                aiScore: totalScore,
                                aiApproved: true
                            };

                            // Save as ALERTED immediately
                            await this.storage.saveSeenToken(token.mint, {
                                symbol: token.symbol,
                                firstSeenAt: Date.now(),
                                lastAlertAt: Date.now(),
                                lastScore: combinedScore,
                                lastPhase: 'ALERTED',
                                storedAnalysis: JSON.stringify(mechanicalNarrative),
                                rawSnapshot: enrichedToken
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
            const rejectionBreakdown = Object.entries(rejectionReasons)
                .sort((a, b) => b[1] - a[1]) // Sort by count descending
                .map(([reason, count]) => `   • ${reason}: ${count}`)
                .join('\n');

            logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 [SCAN SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Total Fetched: ${dexTokens.length}
🔄 Cached (4h): ${cachedCount}
🎯 Fresh Processed: ${freshCandidates.length}

🛑 REJECTED (${totalRejected}):
  ⛔ GATE (Liq/Risk): ${gateCount}
${rejectionBreakdown}
  📉 WEAK (Score <70): ${weakCount}

✅ SNIPED: ${alertCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        } finally {
            this.isScanning = false;
        }
    }


    /**
     * SECURITY CHECK (GoPlus API for Base)
     */
    private async checkRugSecurity(mint: string): Promise<{ safe: boolean; reason?: string }> {
        try {
            // Use GoPlus Service for Base/EVM checks
            const isSafe = await this.goPlus.checkToken(mint, 'base');

            if (!isSafe) {
                return { safe: false, reason: 'GoPlus Security Risk (Honeypot/Mintable/Blacklist)' };
            }

            return { safe: true };

        } catch (err) {
            logger.error(`[Security] Check failed: ${err}`);
            // Fail-safe: Block if security check fails? Or allow with warning?
            // "Your job is to protect -> Block"
            return { safe: false, reason: 'Security Check Failed (API)' };
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

            // TIMEOUT CHECK (>60 Mins)
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

                if (!narrative) {
                    narrative = {
                        headline: `📉 DIP ENTRY TRIGGERED`,
                        narrativeText: `Dip Entry Triggered`,
                        dataSection: `• MC: $${(currentMc).toLocaleString()}\n• Target: $${(targetMc).toLocaleString()}`,
                        tradeLens: `WAITING -> TRACKING`,
                        vibeCheck: `Requires Manual Review`,
                        aiScore: seenData?.lastScore || 7,
                        aiApproved: true
                    };
                }

                if (narrative) {
                    await this.bot.sendTokenAlert(liveToken, narrative, `CORRECTION ENTRY: $${candidate.symbol} 📉`);
                    await this.storage.activateDipToken(candidate.mint, liveToken.priceUsd || 0, currentMc);
                    await this.cooldown.recordAlert(liveToken.mint, seenData?.lastScore || 7, 'TRACKING', liveToken.priceUsd);
                }
            }
        }
    }
}
