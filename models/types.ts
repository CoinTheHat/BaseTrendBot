
// Core Token Snapshot (Unified Model)
export interface TokenSnapshot {
    source: "pumpfun" | "dexscreener" | "birdeye" | "combined";
    chain?: "solana" | "base";
    mint: string;
    name: string;
    symbol: string;
    priceUsd?: number;
    marketCapUsd?: number;
    liquidityUsd?: number;
    volume5mUsd?: number;
    volume30mUsd?: number;
    volume24hUsd?: number; // Added for BirdEye
    buyers5m?: number;
    buyers30m?: number;
    priceChange5m?: number; // %
    txs5m?: { buys: number; sells: number };
    createdAt?: Date; // Launch time
    updatedAt: Date;  // Last scan time
    devWalletConcentration?: number; // %
    top10HoldersSupply?: number; // %
    mintAuthority?: boolean; // true if mint is open
    lpLocked?: boolean;
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
    phase: "SPOTTED" | "TRACKING" | "COOKING" | "SERVED";
}

// Narrative
export interface Narrative {
    narrativeText: string;
    dataSection: string;
    tradeLens: string;
    vibeCheck: string;
    aiScore?: number; // Added for Gatekeeper
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
    status: 'TRACKING' | 'MOONED' | 'RUGGED' | 'STABLE';
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
