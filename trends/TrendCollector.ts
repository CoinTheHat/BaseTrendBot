import { TwitterTrendsService } from './TwitterTrendsService';
import { TrendItem } from '../models/types';
import { logger } from '../utils/Logger';
import fs from 'fs';
import path from 'path';

export class TrendCollector {
    private trends: TrendItem[] = [];
    private filePath: string;

    constructor(private twitterService: TwitterTrendsService) {
        this.filePath = path.resolve(__dirname, '../../storage/trends.json');
        this.load();
    }

    async refresh() {
        logger.info('[TrendCollector] Refreshing trends...');

        // 1. Fetch
        const twitterTrends = await this.twitterService.fetchTrends();

        // 2. Merge Strategies (Simple replacement or sophisticated merge)
        // For V1.1, we'll replace or append distinct ones.

        // Deduplicate by phrase
        const trendMap = new Map<string, TrendItem>();

        // Keep existing manual ones? Maybe.
        // For now, let's refresh fully from valid sources.

        twitterTrends.forEach(t => trendMap.set(t.phrase.toLowerCase(), t));

        // Recalculate Scores
        for (const t of trendMap.values()) {
            this.calculateScore(t);
        }

        this.trends = Array.from(trendMap.values()).sort((a, b) => b.trendScore - a.trendScore);

        this.save();
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

    private load() {
        try {
            if (fs.existsSync(this.filePath)) {
                this.trends = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        } catch (e) {
            logger.error('[TrendCollector] Load failed', e);
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.trends, null, 2));
        } catch (e) {
            logger.error('[TrendCollector] Save failed', e);
        }
    }
}
