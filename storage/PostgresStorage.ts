import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { MemeWatchItem, TrendItem, TokenPerformance } from '../models/types';
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
            );`,
            `CREATE TABLE IF NOT EXISTS token_performance(
                mint TEXT PRIMARY KEY,
                symbol TEXT,
                alert_mc NUMERIC,
                ath_mc NUMERIC,
                current_mc NUMERIC,
                found_mc NUMERIC,
                max_mc NUMERIC,
                status TEXT DEFAULT 'TRACKING',
                alert_timestamp TIMESTAMP DEFAULT NOW(),
                found_at TIMESTAMP DEFAULT NOW(),
                last_updated TIMESTAMP DEFAULT NOW(),
                entry_price NUMERIC DEFAULT 0,
                dip_target_mc NUMERIC DEFAULT 0
            );`,
            `CREATE TABLE IF NOT EXISTS keyword_alerts (
                tweet_id TEXT PRIMARY KEY,
                keyword TEXT,
                content TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );`
        ];

        try {
            for (const q of queries) {
                await this.pool.query(q);
            }
            // Auto-Migration
            // Auto-Migration (Ensure Columns Exist)
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS last_price NUMERIC;`);
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS symbol TEXT;`);
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS dip_target_mc NUMERIC DEFAULT 0;`);
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS stored_analysis TEXT;`);
            await this.pool.query(`ALTER TABLE seen_tokens ADD COLUMN IF NOT EXISTS raw_snapshot JSONB;`); // NEW: FULL AI DATA

            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS entry_price NUMERIC DEFAULT 0;`);
            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS found_mc NUMERIC;`);
            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS max_mc NUMERIC;`);
            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS found_at TIMESTAMP DEFAULT NOW();`);
            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS sold_mc NUMERIC DEFAULT 0;`);
            await this.pool.query(`ALTER TABLE token_performance ADD COLUMN IF NOT EXISTS dip_target_mc NUMERIC DEFAULT 0;`); // ENSURE THIS EXISTS

            // Backfill: found_mc = alert_mc, max_mc = ath_mc for existing rows
            await this.pool.query(`UPDATE token_performance SET found_mc = alert_mc WHERE found_mc IS NULL;`);
            await this.pool.query(`UPDATE token_performance SET max_mc = ath_mc WHERE max_mc IS NULL;`);
            await this.pool.query(`UPDATE token_performance SET found_at = alert_timestamp WHERE found_at IS NULL;`);

            // CLEANUP: Remove Base/EVM tokens (starting with 0x)
            await this.pool.query(`DELETE FROM token_performance WHERE mint LIKE '0x%';`);
            await this.pool.query(`DELETE FROM seen_tokens WHERE mint LIKE '0x%';`);

            logger.info('[Postgres] Schema initialized.');
        } catch (err) {
            logger.error('[Postgres] Schema init failed', err);
        }
    }

    // ... (Existing methods) ...

    // --- Performance Monitor ---

    async savePerformance(perf: TokenPerformance & { dipTargetMc?: number }) {
        // Prevent EVM/Base tokens
        if (perf.mint.startsWith('0x')) return;
        try {
            await this.pool.query(
                `INSERT INTO token_performance(
                    mint, symbol, alert_mc, ath_mc, current_mc, status, alert_timestamp, last_updated, entry_price,
                    found_mc, max_mc, found_at, sold_mc, dip_target_mc
                )
                VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $4, $7, 0, $10)
                ON CONFLICT(mint) DO UPDATE SET
                    ath_mc = GREATEST(token_performance.ath_mc, EXCLUDED.ath_mc),
                    current_mc = EXCLUDED.current_mc,
                    last_updated = NOW(),
                    dip_target_mc = COALESCE(NULLIF(EXCLUDED.dip_target_mc, 0), token_performance.dip_target_mc),
                    entry_price = COALESCE(NULLIF(EXCLUDED.entry_price, 0), token_performance.entry_price),
                    status = EXCLUDED.status`,
                [
                    perf.mint,
                    perf.symbol,
                    perf.alertMc,
                    perf.athMc,
                    perf.currentMc,
                    perf.status,
                    perf.alertTimestamp,
                    perf.lastUpdated,
                    perf.entryPrice || 0,
                    perf.dipTargetMc || 0
                ]
            );
        } catch (err) {
            logger.error('[Postgres] savePerformance failed', err);
        }
    }

    async updatePerformance(perf: TokenPerformance) {
        try {
            await this.pool.query(
                `UPDATE token_performance
                 SET ath_mc = $2, current_mc = $3, status = $4, last_updated = NOW()
                 WHERE mint = $1`,
                [perf.mint, perf.athMc, perf.currentMc, perf.status]
            );
        } catch (err) {
            logger.error('[Postgres] updatePerformance failed', err);
        }
    }

    async updateSoldMC(mint: string, soldMc: number) {
        try {
            const res = await this.pool.query(
                `UPDATE token_performance
                 SET sold_mc = $1, last_updated = NOW()
                 WHERE mint = $2`,
                [soldMc, mint]
            );

            if (res.rowCount === 0) {
                // Upsert: If not in performance, move it there so we can save sold_mc
                const seen = await this.getSeenToken(mint);
                if (seen) {
                    const alertMc = seen.rawSnapshot?.marketCapUsd || 0;
                    // Insert new performance record
                    await this.pool.query(
                        `INSERT INTO token_performance (
                            mint, symbol, alert_mc, ath_mc, current_mc, 
                            status, alert_timestamp, last_updated, entry_price, sold_mc
                        ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000), NOW(), $8, $9)`,
                        [
                            mint,
                            seen.symbol,
                            alertMc,
                            alertMc,
                            0,
                            'TRACKING',
                            seen.lastAlertAt || seen.firstSeenAt,
                            seen.rawSnapshot?.priceUsd || 0,
                            soldMc
                        ]
                    );
                    logger.info(`[Postgres] Promoted ${mint} from Seen to Performance (Sold MC Update)`);
                    return;
                }
            }

            logger.info(`[Postgres] Updated Sold MC for ${mint}: $${soldMc}`);
        } catch (err) {
            logger.error(`[Postgres] updateSoldMC failed for ${mint}`, err);
        }
    }

    // SELF-HEALING: Update missing details like Symbol and Alert MC using fresh API data
    async updatePerformanceEnriched(perf: TokenPerformance) {
        try {
            await this.pool.query(
                `UPDATE token_performance
                 SET 
                    symbol = COALESCE(NULLIF($2, ''), symbol),
                    alert_mc = CASE WHEN alert_mc = 0 THEN $3 ELSE alert_mc END,
                    ath_mc = $4,
                    current_mc = $5,
                    status = $6,
                    last_updated = NOW(),
                    entry_price = CASE WHEN entry_price = 0 THEN $7 ELSE entry_price END
                 WHERE mint = $1`,
                [perf.mint, perf.symbol, perf.alertMc, perf.athMc, perf.currentMc, perf.status, perf.entryPrice || 0]
            );
        } catch (err) {
            logger.error('[Postgres] updatePerformanceEnriched failed', err);
        }
    }

    // BACKFILL: Sync missing tokens from seen_tokens to token_performance
    async backfillMissingTokens(): Promise<number> {
        try {
            const query = `
                INSERT INTO token_performance (mint, symbol, alert_mc, ath_mc, current_mc, status, alert_timestamp)
                SELECT 
                    st.mint,
                    '' as symbol,
                    0 as alert_mc,
                    0 as ath_mc,
                    0 as current_mc,
                    'TRACKING' as status,
                    to_timestamp(st.first_seen_at / 1000) as alert_timestamp
                FROM seen_tokens st
                WHERE st.last_alert_at > 0
                AND st.mint NOT IN (SELECT mint FROM token_performance)
                ON CONFLICT (mint) DO NOTHING
            `;
            const res = await this.pool.query(query);
            const count = res.rowCount || 0;
            if (count > 0) {
                logger.info(`[Postgres] Backfilled ${count} missing tokens to token_performance`);
            }
            return count;
        } catch (err) {
            logger.error('[Postgres] backfillMissingTokens failed', err);
            return 0;
        }
    }

    async getTrackingTokens(): Promise<TokenPerformance[]> {
        try {
            // Get ALL tokens (TRACKING, RUGGED, ARCHIVED) for dashboard
            const res = await this.pool.query(
                `SELECT * FROM token_performance 
                 WHERE alert_timestamp > NOW() - INTERVAL '48 hours'
                 ORDER BY alert_timestamp DESC`
            );
            return res.rows.map(row => this.mapPerformanceRow(row));
        } catch (err) {
            logger.error('[Postgres] getTrackingTokens failed', err);
            return [];
        }
    }

    // NEW: Get single token performance for Autopsy/Details
    async getPerformance(mint: string): Promise<TokenPerformance | null> {
        try {
            const res = await this.pool.query('SELECT * FROM token_performance WHERE mint = $1', [mint]);
            if (res.rows.length === 0) return null;
            return this.mapPerformanceRow(res.rows[0]);
        } catch (err) {
            logger.error('[Postgres] getPerformance failed', err);
            return null;
        }
    }



    async getDashboardMetrics(): Promise<any> {
        try {
            // UNION QUERY: Combine new system (token_performance) + historical (seen_tokens)
            const combinedView = `
                SELECT 
                    mint, symbol, alert_mc, ath_mc, current_mc, status, alert_timestamp, sold_mc
                FROM token_performance
                
                UNION ALL
                
                SELECT 
                    mint,
                    COALESCE(symbol, 'Unknown') as symbol, -- Use stored symbol
                    0 as alert_mc,
                    0 as ath_mc,
                    0 as current_mc,
                    'HISTORIC' as status,
                    to_timestamp(first_seen_at / 1000) as alert_timestamp,
                    0 as sold_mc
                FROM seen_tokens
                WHERE last_alert_at > 0
                AND mint NOT IN (SELECT mint FROM token_performance)
            `;

            // ... (Rest of query logic remains same) ...

            // 1. Total Calls
            const totalRes = await this.pool.query(`SELECT COUNT(*) FROM (${combinedView}) combined`);
            const totalCalls = parseInt(totalRes.rows[0].count);

            // 2. Win Rate (Tokens with > 2x ATH from Alert, and NOT RUGGED)
            const winRes = await this.pool.query(`
                SELECT COUNT(*) FROM (${combinedView}) combined
                WHERE ath_mc >= alert_mc * 2 AND alert_mc > 0 AND status != 'RUGGED'
            `);
            const moons = parseInt(winRes.rows[0].count);
            const winRate = totalCalls > 0 ? (moons / totalCalls) * 100 : 0;

            // 3. Top Performers (Max Multiple)
            const topRes = await this.pool.query(`
                SELECT *, (ath_mc / NULLIF(alert_mc, 0)) as multiple 
                FROM (${combinedView}) combined
                WHERE alert_mc > 0
                ORDER BY multiple DESC 
                LIMIT 5
            `);

            // 4. Recent Calls
            const recentRes = await this.pool.query(`
                SELECT * FROM (${combinedView}) combined
                ORDER BY alert_timestamp DESC 
                LIMIT 50
            `); // Capabilities boosted to 50 for better PnL view

            return {
                totalCalls,
                winRate: Math.round(winRate),
                moonCount: moons,
                topPerformers: topRes.rows.map(row => this.mapPerformanceRow(row)),
                recentCalls: recentRes.rows.map(row => this.mapPerformanceRow(row))
            };
        } catch (err) {
            logger.error('[Postgres] getDashboardMetrics failed', err);
            return { totalCalls: 0, winRate: 0, moonCount: 0, topPerformers: [], recentCalls: [] };
        }
    }

    private mapPerformanceRow(row: any): TokenPerformance {
        return {
            mint: row.mint,
            symbol: row.symbol,
            alertMc: Number(row.alert_mc),
            athMc: Number(row.ath_mc),
            currentMc: Number(row.current_mc),
            status: row.status,
            alertTimestamp: row.alert_timestamp,
            lastUpdated: row.last_updated,
            entryPrice: row.entry_price ? Number(row.entry_price) : 0,
            soldMc: row.sold_mc ? Number(row.sold_mc) : 0 // NEW
        };
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
                symbol: row.symbol,
                firstSeenAt: Number(row.first_seen_at),
                lastAlertAt: Number(row.last_alert_at),
                lastScore: row.last_score,
                lastPhase: row.last_phase,
                lastPrice: row.last_price ? Number(row.last_price) : undefined,
                dipTargetMc: row.dip_target_mc ? Number(row.dip_target_mc) : undefined,
                storedAnalysis: row.stored_analysis,
                rawSnapshot: row.raw_snapshot // Mapped from JSONB
            };
        } catch (err) {
            logger.error('[Postgres] getSeenToken failed', err);
            return null;
        }
    }

    async saveSeenToken(mint: string, data: SeenTokenData) {
        if (mint.startsWith('0x')) return;
        try {
            await this.pool.query(
                `INSERT INTO seen_tokens(mint, symbol, first_seen_at, last_alert_at, last_score, last_phase, last_price, dip_target_mc, stored_analysis, raw_snapshot)
                 VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT(mint) DO UPDATE SET
                    symbol = COALESCE(EXCLUDED.symbol, seen_tokens.symbol),
                    last_alert_at = EXCLUDED.last_alert_at,
                    last_score = EXCLUDED.last_score,
                    last_phase = EXCLUDED.last_phase,
                    last_price = EXCLUDED.last_price,
                    dip_target_mc = EXCLUDED.dip_target_mc,
                    stored_analysis = EXCLUDED.stored_analysis,
                    raw_snapshot = COALESCE(EXCLUDED.raw_snapshot, seen_tokens.raw_snapshot);`,
                [
                    mint,
                    data.symbol || null,
                    data.firstSeenAt,
                    data.lastAlertAt,
                    data.lastScore,
                    data.lastPhase,
                    data.lastPrice || 0,
                    data.dipTargetMc || 0,
                    data.storedAnalysis || null,
                    data.rawSnapshot ? JSON.stringify(data.rawSnapshot) : null // Store full token object
                ]
            );
        } catch (err) {
            logger.error('[Postgres] saveSeenToken failed', err);
        }
    }

    // --- Trends ---

    async saveTrends(trends: TrendItem[]) {
        // Full replace or Upsert? Strategy: Upsert.
        try {
            for (const t of trends) {
                await this.pool.query(
                    `INSERT INTO trends(id, phrase, source, metrics, trend_score, last_updated)
        VALUES($1, $2, $3, $4, $5, $6)
                     ON CONFLICT(phrase) DO UPDATE SET
        trend_score = EXCLUDED.trend_score,
            metrics = EXCLUDED.metrics,
            last_updated = EXCLUDED.last_updated; `,
                    [t.id, t.phrase, t.source, JSON.stringify(t.metrics), t.trendScore, t.lastUpdated]
                );
            }
        } catch (err) {
            logger.error('[Postgres] saveTrends failed', err);
        }
    }

    /**
     * Correction Mechanism for Autopsy
     * Uses OHLC High to fix "Missed Peaks"
     */
    async correctATH(mint: string, trueAthMc: number) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                 SET ath_mc = GREATEST(ath_mc, $2), 
                     max_mc = GREATEST(max_mc, $2),
                     status = CASE WHEN $2 >= alert_mc * 2 THEN 'MOONED' ELSE status END
                 WHERE mint = $1`,
                [mint, trueAthMc]
            );
            // logger.info(`[Postgres] Corrected ATH for ${mint} to $${trueAthMc}`);
        } catch (err) {
            logger.error('[Postgres] correctATH failed', err);
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
    // --- Keyword Sniper ---

    async hasSeenKeywordTweet(tweetId: string): Promise<boolean> {
        try {
            const res = await this.pool.query('SELECT 1 FROM keyword_alerts WHERE tweet_id = $1', [tweetId]);
            return res.rowCount !== null && res.rowCount > 0;
        } catch (err) {
            logger.error('[Postgres] hasSeenKeywordTweet failed', err);
            return false;
        }
    }

    async saveKeywordTweet(tweetId: string, keyword: string, content: string) {
        try {
            await this.pool.query(
                `INSERT INTO keyword_alerts (tweet_id, keyword, content)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (tweet_id) DO NOTHING`,
                [tweetId, keyword, content]
            );
        } catch (err) {
            logger.error('[Postgres] saveKeywordTweet failed', err);
        }
    }

    // === PORTFOLIO TRACKING METHODS ===

    async getAllTrackingTokens(): Promise<any[]> {
        try {
            const res = await this.pool.query(
                `SELECT 
                    mint, symbol, found_mc, max_mc, current_mc, 
                    status, found_at, last_updated, entry_price
                FROM token_performance 
                WHERE status = 'TRACKING'
                ORDER BY found_at DESC`
            );
            return res.rows;
        } catch (err) {
            logger.error('[Postgres] getAllTrackingTokens failed', err);
            return [];
        }
    }

    // UPDATED: Supports explicit batch high for ATH protection
    async updateTokenMC(mint: string, currentMc: number, potentialMaxMc: number) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                SET current_mc = $1,
                    max_mc = GREATEST(COALESCE(max_mc, 0), $2),
                    last_updated = NOW()
                WHERE mint = $3`,
                [currentMc, potentialMaxMc, mint]
            );
        } catch (err) {
            logger.error(`[Postgres] updateTokenMC failed for ${mint}`, err);
        }
    }

    async updateMaxMC(mint: string, maxMc: number) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                 SET max_mc = $1, last_updated = NOW() 
                 WHERE mint = $2`,
                [maxMc, mint]
            );
            logger.info(`[Postgres] Updated Max MC for ${mint}: $${maxMc}`);
        } catch (err) {
            logger.error(`[Postgres] updateMaxMC failed for ${mint}`, err);
            throw err;
        }
    }

    async updateTokenStatus(mint: string, status: 'TRACKING' | 'ARCHIVED' | 'RUGGED') {
        try {
            const res = await this.pool.query(
                `UPDATE token_performance 
                 SET status = $1, last_updated = NOW() 
                 WHERE mint = $2`,
                [status, mint]
            );

            if (res.rowCount === 0 && status === 'RUGGED') {
                // Upsert: If not in performance (Historic/Seen Only), move it there so we can track it as RUGGED
                const seen = await this.getSeenToken(mint);
                if (seen) {
                    const alertMc = seen.rawSnapshot?.marketCapUsd || 0;
                    // Insert new performance record
                    await this.pool.query(
                        `INSERT INTO token_performance (
                            mint, symbol, alert_mc, ath_mc, current_mc, 
                            status, alert_timestamp, last_updated, entry_price
                        ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000), NOW(), $8)`,
                        [
                            mint,
                            seen.symbol,
                            alertMc,
                            alertMc, // Start ATH at Entry
                            0,       // Current likely 0 if Rugged
                            status,
                            seen.lastAlertAt || seen.firstSeenAt,
                            seen.rawSnapshot?.priceUsd || 0
                        ]
                    );
                    logger.info(`[Postgres] Promoted ${mint} from Seen to Performance as ${status}`);
                    return;
                }
            }

            logger.info(`[Postgres] Updated status for ${mint} to ${status}`);
        } catch (err) {
            logger.error(`[Postgres] updateTokenStatus failed for ${mint}`, err);
            throw err;
        }
    }

    async archiveToken(mint: string) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                SET status = 'ARCHIVED', last_updated = NOW()
                WHERE mint = $1`,
                [mint]
            );
        } catch (err) {
            logger.error(`[Postgres] archiveToken failed for ${mint}`, err);
        }
    }

    async getWaitingForDipTokens(): Promise<(TokenPerformance & { dipTargetMc: number })[]> {
        try {
            const res = await this.pool.query(
                `SELECT * FROM token_performance 
                 WHERE status = 'WAITING_DIP'
                 ORDER BY alert_timestamp ASC`
            );
            return res.rows.map(row => ({
                ...this.mapPerformanceRow(row),
                dipTargetMc: Number(row.dip_target_mc || 0)
            }));
        } catch (err) {
            logger.error('[Postgres] getWaitingForDipTokens failed', err);
            return [];
        }
    }

    async activateDipToken(mint: string, entryPrice: number, entryMc: number) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                 SET status = 'TRACKING', 
                     entry_price = $1, 
                     found_mc = $2,
                     alert_mc = $2, 
                     current_mc = $2,
                     ath_mc = $2,
                     max_mc = $2,
                     last_updated = NOW()
                 WHERE mint = $3`,
                [entryPrice, entryMc, mint]
            );
            logger.info(`[Postgres] Activated Dip Token: ${mint} @ $${entryPrice}`);
        } catch (err) {
            logger.error(`[Postgres] activateDipToken failed for ${mint}`, err);
        }
    }

    async failDipToken(mint: string, reason: string) {
        try {
            await this.pool.query(
                `UPDATE token_performance 
                 SET status = $1, last_updated = NOW() 
                 WHERE mint = $2`,
                [reason, mint]
            );
        } catch (err) {
            logger.error(`[Postgres] failDipToken failed for ${mint}`, err);
        }
    }
    async resetDatabase(): Promise<void> {
        try {
            logger.warn('[Postgres] 🧨 RESETTING DATABASE BY ADMIN REQUEST...');
            await this.pool.query('TRUNCATE TABLE seen_tokens CASCADE');
            await this.pool.query('TRUNCATE TABLE token_performance CASCADE');
            await this.pool.query('TRUNCATE TABLE trends CASCADE');
            await this.pool.query('TRUNCATE TABLE keyword_alerts CASCADE');
            logger.info('[Postgres] ✅ Database reset complete.');
        } catch (err) {
            logger.error('[Postgres] Reset failed:', err);
            throw err;
            throw err;
        }
    }

    async deleteToken(mint: string): Promise<void> {
        try {
            await this.pool.query('DELETE FROM seen_tokens WHERE mint = $1', [mint]);
            await this.pool.query('DELETE FROM token_performance WHERE mint = $1', [mint]);
            logger.info(`[Postgres] Deleted token ${mint}`);
        } catch (err) {
            logger.error(`[Postgres] Failed to delete token ${mint}`, err);
            throw err;
        }
    }
    // --- Autopsy / AI Training Data ---

    async getAutopsyCandidates(): Promise<TokenPerformance[]> {
        try {
            // Find tokens older than 24 hours that haven't been finalized with a True ATH check
            // We assume if 'status' is not 'AUTOPSIED' it needs check, OR we check a new flag.
            // For now, let's use a time check and status check.
            const res = await this.pool.query(
                `SELECT * FROM token_performance 
                 WHERE alert_timestamp < NOW() - INTERVAL '24 hours'
                 AND status != 'AUTOPSIED'
                 LIMIT 50`
            );
            return res.rows.map(row => this.mapPerformanceRow(row));
        } catch (err) {
            logger.error('[Postgres] getAutopsyCandidates failed', err);
            return [];
        }
    }

    async updateTrueAth(mint: string, trueAthMc: number) {
        try {
            // We update status to 'AUTOPSIED' so we don't check again
            await this.pool.query(
                `UPDATE token_performance
                 SET ath_mc = GREATEST(ath_mc, $2), -- Update ATH if we found a higher one
                     status = 'AUTOPSIED'
                 WHERE mint = $1`,
                [mint, trueAthMc]
            );
            logger.info(`[Postgres] Autopsy Complete for ${mint}. Final ATH: $${trueAthMc}`);
        } catch (err) {
            logger.error('[Postgres] updateTrueAth failed', err);
        }
    }

    async getAutopsyReport(): Promise<any[]> {
        try {
            const res = await this.pool.query(`
                SELECT 
                    mint, 
                    symbol, 
                    alert_mc, 
                    ath_mc, 
                    status, 
                    alert_timestamp,
                    CASE 
                        WHEN alert_mc > 0 THEN ath_mc / alert_mc 
                        ELSE 0 
                    END as multiplier
                FROM token_performance
                WHERE alert_mc > 0 -- Only tokens that were actually alerted
                ORDER BY multiplier DESC
                LIMIT 200 -- Increase limit to capture history
            `);
            return res.rows.map(row => ({
                symbol: row.symbol,
                mint: row.mint,
                entryMc: Number(row.alert_mc),
                athMc: Number(row.ath_mc),
                multiplier: Number(row.multiplier).toFixed(2),
                date: row.alert_timestamp,
                status: row.status
            }));
        } catch (err) {
            logger.error('[Postgres] getAutopsyReport failed', err);
            return [];
        }
    }
}
