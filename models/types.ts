
// Core Token Snapshot (Unified Model)
export interface TokenSnapshot {
    source: "pumpfun" | "dexscreener" | "birdeye" | "combined";
    chain?: "solana" | "base";
    mint: string;
    pairAddress?: string; // NEW: Required for Internal API
    name: string;
    symbol: string;
    priceUsd?: number;
    marketCapUsd?: number;
    liquidityUsd?: number;
    volume5mUsd?: number;
    volume30mUsd?: number;
    volume24hUsd?: number;
    volumeTrend?: 'increasing' | 'flat' | 'decreasing'; // NEW
    buyers5m?: number;
    sellers5m?: number; // NEW
    buyers30m?: number;
    priceChange5m?: number; // %
    priceChange1h?: number; // NEW
    priceChange6h?: number; // NEW
    txs5m?: { buys: number; sells: number }; // Existing but robust
    createdAt?: Date; // Launch time
    updatedAt: Date;  // Last scan time
    devWalletConcentration?: number; // %
    holderCount?: number; // NEW: Total holders
    top10HoldersSupply?: number; // %
    mintAuthority?: boolean; // Deprecated but mapping to isMintable
    isMintable?: boolean;
    isFreezable?: boolean;
    lpLocked?: boolean;
    lpBurned?: boolean;
    lpLockedPercent?: number;
    isCTO?: boolean;
    links: {
        dexScreener?: string;
        pumpfun?: string;
        birdeye?: string;
    };
}

// Watchlist Item
export interface MemeWatchItem {
    id: string;
    phrase: string;        // e.g. "sad penguin"
    tags: string[];        // ["penguin", "depressed", "mountain"]
    createdAt: Date;
}

// Matching Result
export interface MemeMatchResult {
    memeMatch: boolean;
    matchedMeme?: MemeWatchItem;
    matchScore?: number; // 0..1
}

// Scoring & Phase
export interface ScoreBreakdown {
    factor: string;
    points: number;
    details: string;
}

export interface ScoreResult {
    totalScore: number;
    breakdown: ScoreBreakdown[];
    phase: "SPOTTED" | "TRACKING" | "COOKING" | "SERVED" | "REJECTED_RISK";
}

// Narrative
export interface Narrative {
    narrativeText: string;
    dataSection: string;
    tradeLens: string;
    vibeCheck: string;
    // Granular AI Fields for Accelerando Format
    headline?: string;
    analystSummary?: string;
    technicalOutlook?: string;
    socialVibe?: string;
    riskAnalysis?: string;
    strategy?: string;
    vibe?: string; // Short Emojified Vibe
    aiScore?: number; // Added for Gatekeeper
    aiApproved?: boolean; // Explicit approval flag
    aiReason?: string; // Added for Logging
    twitterStory?: {
        summary: string;
        sampleLines: string[];
        trustScore?: number; // 0..100
        riskAnalysis?: {
            level: "SAFE" | "UNKNOWN" | "SUSPICIOUS" | "DANGEROUS";
            flags: string[];
        };
        potentialCategory?: "EARLY_ALPHA" | "VIRAL_HIGH_RISK" | "STANDARD" | "SUPER_ALPHA";
    };
}

// Trends
export interface TrendItem {
    id: string;
    phrase: string;          // e.g. "sad penguin"
    source: ("twitter" | "tiktok" | "instagram" | "manual" | "fallback")[];
    metrics: {
        twitterTweets?: number;
        twitterEngagementScore?: number;
        tiktokViews?: number;
        instaReels?: number;
    };
    trendScore: number;      // 0..100
    lastUpdated: Date;
}

export interface TrendTokenMatch {
    trend: TrendItem;
    tokens: {
        snapshot: TokenSnapshot;
        score: number;
        phase?: string;
    }[];
}

export interface TokenPerformance {
    mint: string;
    symbol: string;
    alertMc: number;
    athMc: number;
    currentMc: number;
    foundMc?: number; // Added for PnL
    soldMc?: number; // Added for PnL
    maxMc?: number; // Added for PnL
    dipTargetMc?: number; // Added for Dip Tracking
    entryPrice?: number; // Added for V3 Autopsy
    mc30m?: number; // Added for Strategy 3 (Time-Based Exit)
    maxMc30m?: number; // Added for Hybrid 30m Strategy
    status: 'TRACKING' | 'MOONED' | 'RUGGED' | 'STABLE' | 'FAILED' | 'FAILED_NO_DATA' | 'FINALIZED' | 'FINALIZED_MOONED' | 'FINALIZED_FAILED' | 'WAITING_FOR_DIP' | 'MISSED_DIP' | 'WAITING_DIP';
    alertTimestamp: Date;
    lastUpdated: Date;
}

export interface DashboardMetrics {
    totalCalls: number;
    winRate: number; // % of calls > 2x
    moonCount: number;
    topPerformers: TokenPerformance[];
    recentCalls: TokenPerformance[];
}

export interface SeenTokenData {
    symbol: string;
    firstSeenAt: number;
    lastAlertAt: number;
    lastScore: number;
    lastPhase: string;
    lastPrice?: number;
    dipTargetMc?: number;
    storedAnalysis?: string;
}
