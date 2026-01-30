import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { MemeWatchItem, TrendItem } from '../models/types';
import { SeenTokenData } from './JsonStorage'; // Reusing interface or we can move it

export class PostgresStorage {
    private pool: Pool;
    private isConnected = false;

    constructor() {
        this.pool = new Pool({
            connectionString: config.DATABASE_URL,
            ssl: config.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } // Auto-SSL for Cloud
        });

        this.pool.on('error', (err) => {
            logger.error('[Postgres] Unexpected error on idle client', err);
            this.isConnected = false;
        });
    }

    async connect() {
        if (this.isConnected) return;
        try {
            const client = await this.pool.connect();
            logger.info('[Postgres] Connected to database successfully.');
            client.release();
            this.isConnected = true;
            await this.initSchema();
        } catch (err) {
            logger.error('[Postgres] Connection failed', err);
            // Process might crash if DB is vital, or retry.
        }
    }

    private async initSchema() {
        const queries = [
            `CREATE TABLE IF NOT EXISTS watchlist (
                id TEXT PRIMARY KEY,
                phrase TEXT UNIQUE NOT NULL,
                tags TEXT[],
                created_at TIMESTAMP DEFAULT NOW()
            );`,
            `CREATE TABLE IF NOT EXISTS seen_tokens (
                mint TEXT PRIMARY KEY,
                first_seen_at BIGINT,
                last_alert_at BIGINT,
                last_score INTEGER,
                last_phase TEXT
            );`,
            `CREATE TABLE IF NOT EXISTS trends (
                id TEXT PRIMARY KEY,
                phrase TEXT UNIQUE,
                source TEXT[],
                metrics JSONB,
                trend_score INTEGER,
                last_updated TIMESTAMP
            );`
        ];

        try {
            for (const q of queries) {
                await this.pool.query(q);
            }
            // Auto-Migration for new features
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS last_price NUMERIC;`);

            logger.info('[Postgres] Schema initialized.');
        } catch (err) {
            logger.error('[Postgres] Schema init failed', err);
        }
    }

    // --- Watchlist ---

    async getWatchlist(): Promise<MemeWatchItem[]> {
        try {
            const res = await this.pool.query('SELECT * FROM watchlist');
            return res.rows.map(row => ({
                id: row.id,
                phrase: row.phrase,
                tags: row.tags || [],
                createdAt: row.created_at
            }));
        } catch (err) {
            logger.error('[Postgres] getWatchlist failed', err);
            return [];
        }
    }

    async addWatchItem(item: MemeWatchItem) {
        try {
            await this.pool.query(
                'INSERT INTO watchlist (id, phrase, tags, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
                [item.id, item.phrase, item.tags, item.createdAt]
            );
        } catch (err) {
            logger.error('[Postgres] addWatchItem failed', err);
        }
    }

    async removeWatchItem(phraseOrId: string) {
        try {
            // Try deleting by ID or Phrase (normalized)
            await this.pool.query(
                'DELETE FROM watchlist WHERE id = $1 OR phrase = $1',
                [phraseOrId]
            );
        } catch (err) {
            logger.error('[Postgres] removeWatchItem failed', err);
        }
    }

    // --- Cooldowns / Seen Tokens ---

    async getSeenToken(mint: string): Promise<SeenTokenData | null> {
        try {
            const res = await this.pool.query('SELECT * FROM seen_tokens WHERE mint = $1', [mint]);
            if (res.rows.length === 0) return null;
            const row = res.rows[0];
            return {
                firstSeenAt: Number(row.first_seen_at),
                lastAlertAt: Number(row.last_alert_at),
                lastScore: row.last_score,
                lastPhase: row.last_phase,
                lastPrice: row.last_price ? Number(row.last_price) : undefined
            };
        } catch (err) {
            logger.error('[Postgres] getSeenToken failed', err);
            return null;
        }
    }

    async saveSeenToken(mint: string, data: SeenTokenData) {
        try {
            await this.pool.query(
                `INSERT INTO seen_tokens (mint, first_seen_at, last_alert_at, last_score, last_phase, last_price)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (mint) DO UPDATE SET
                    last_alert_at = EXCLUDED.last_alert_at,
                    last_score = EXCLUDED.last_score,
                    last_phase = EXCLUDED.last_phase,
                    last_price = EXCLUDED.last_price;`,
                [mint, data.firstSeenAt, data.lastAlertAt, data.lastScore, data.lastPhase, data.lastPrice || 0]
            );
        } catch (err) {
            logger.error('[Postgres] saveSeenToken failed', err);
        }
    }

    // --- Trends ---

    async saveTrends(trends: TrendItem[]) {
        // Full replace or Upsert? Strategy: Upsert.
        // We might want to clear old trends, but for now let's just Upsert active ones.
        try {
            for (const t of trends) {
                await this.pool.query(
                    `INSERT INTO trends (id, phrase, source, metrics, trend_score, last_updated)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (phrase) DO UPDATE SET
                        trend_score = EXCLUDED.trend_score,
                        metrics = EXCLUDED.metrics,
                        last_updated = EXCLUDED.last_updated;`,
                    [t.id, t.phrase, t.source, JSON.stringify(t.metrics), t.trendScore, t.lastUpdated]
                );
            }
        } catch (err) {
            logger.error('[Postgres] saveTrends failed', err);
        }
    }

    async getTrends(): Promise<TrendItem[]> {
        try {
            const res = await this.pool.query('SELECT * FROM trends ORDER BY trend_score DESC LIMIT 50');
            return res.rows.map(row => ({
                id: row.id,
                phrase: row.phrase,
                source: row.source,
                metrics: row.metrics,
                trendScore: row.trend_score,
                lastUpdated: row.last_updated
            }));
        } catch (err) {
            logger.error('[Postgres] getTrends failed', err);
            return [];
        }
    }
}
