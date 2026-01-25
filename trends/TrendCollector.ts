import { TwitterTrendsService } from './TwitterTrendsService';
import { TrendItem } from '../models/types';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';

export class TrendCollector {
    private trends: TrendItem[] = [];

    constructor(
        private twitterService: TwitterTrendsService,
        private storage: PostgresStorage
    ) { }

    async init() {
        this.trends = await this.storage.getTrends();
        if (this.trends.length === 0) {
            await this.refresh();
        }
    }

    async refresh() {
        logger.info('[TrendCollector] Refreshing trends...');

        // 1. Fetch
        const twitterTrends = await this.twitterService.fetchTrends();

        // 2. Merge Strategies (Simple replacement or sophisticated merge)
        // Deduplicate by phrase
        const trendMap = new Map<string, TrendItem>();

        twitterTrends.forEach(t => trendMap.set(t.phrase.toLowerCase(), t));

        // Recalculate Scores
        for (const t of trendMap.values()) {
            this.calculateScore(t);
        }

        this.trends = Array.from(trendMap.values()).sort((a, b) => b.trendScore - a.trendScore);

        await this.storage.saveTrends(this.trends);
        logger.info(`[TrendCollector] Refreshed. Top trend: ${this.trends[0]?.phrase} (${this.trends[0]?.trendScore})`);
        return this.trends;
    }

    getTopTrends(limit = 10): TrendItem[] {
        return this.trends.slice(0, limit);
    }

    private calculateScore(item: TrendItem) {
        // Heuristic:
        // Twitter Volume > 10k -> +50
        // Multi-source -> +20

        let score = 0;
        if (item.metrics.twitterTweets) {
            if (item.metrics.twitterTweets > 50000) score += 80;
            else if (item.metrics.twitterTweets > 10000) score += 60;
            else score += 40;
        }

        if (item.source.length > 1) score += 20; // Cross-platform bonus

        // Cap at 100
        item.trendScore = Math.min(100, score);
    }
}
