import express from 'express';
import path from 'path';
import { PostgresStorage } from '../storage/PostgresStorage';
import { logger } from '../utils/Logger';

export class DashboardServer {
    private app;
    private port;

    constructor(private storage: PostgresStorage, port: number = 3000) {
        this.app = express();
        this.port = process.env.PORT ? parseInt(process.env.PORT) : port;

        // AUTHENTICATION
        const basicAuth = require('express-basic-auth');
        const { config } = require('../config/env');

        this.app.use(basicAuth({
            users: { [config.DASHBOARD_USER]: config.DASHBOARD_PASS },
            challenge: true,
            realm: 'TrendBot Admin Area'
        }));

        // Setup EJS
        this.app.set('view engine', 'ejs');

        // FIX: Use __dirname to locate files relative to the script (works in src and dist)
        // In src: web/DashboardServer.ts -> views is ./views
        // In dist: dist/web/DashboardServer.js -> views is ./views (copied via build script)
        const viewsPath = path.join(__dirname, 'views');
        this.app.set('views', viewsPath);

        // Public static files
        const publicPath = path.join(__dirname, 'public');
        this.app.use(express.static(publicPath));

        logger.info(`[Dashboard] CWD: ${process.cwd()}`);
        logger.info(`[Dashboard] Root (__dirname): ${__dirname}`);
        logger.info(`[Dashboard] Views Path: ${viewsPath}`);
        logger.info(`[Dashboard] Public Path: ${publicPath}`);

        // Routes
        this.setupRoutes();
    }

    private setupRoutes() {
        // API Endpoint: Dashboard verilerini gönderir
        this.app.get('/api/calls', async (req, res) => {
            try {
                // Use existing storage method
                const metrics = await this.storage.getDashboardMetrics();

                // Frontend'in beklediği format (HTML ile %100 uyumlu)
                // Adapting TokenPerformance (flat) to User's desired structure
                const recentCalls = metrics.recentCalls.map((t: any) => {
                    const entryMc = t.alertMc || 0; // Giriş MC
                    const athMc = t.athMc || entryMc; // ATH MC
                    const multiplier = entryMc > 0 ? (athMc / entryMc) : 1.0;

                    return {
                        symbol: t.symbol,
                        status: t.status, // MOONED, RUGGED, TRACKING
                        alertTimestamp: t.alertTimestamp,
                        entryMc: entryMc,
                        athMc: athMc,
                        multiplier: Number(multiplier.toFixed(2)),
                        mint: t.mint // <--- ÖNEMLİ: DB'de 'mint' olarak saklanıyor.
                    };
                });

                res.json({
                    winRate: metrics.winRate,
                    totalCalls: metrics.totalCalls,
                    moonCount: metrics.moonCount,
                    recentCalls
                });

            } catch (error) {
                logger.error(`Dashboard API Error: ${error}`);
                res.status(500).json({ error: 'Internal Server Error' });
            }
        });

        // Legacy SSR Route (Keep for backup)
        this.app.get('/dashboard', async (req, res) => {
            try {
                const metrics = await this.storage.getDashboardMetrics();
                res.render('dashboard', {
                    metrics,
                    lastUpdated: new Date()
                });
            } catch (err) {
                logger.error('[Dashboard] Error rendering dashboard:', err);
                res.status(500).send('Internal Server Error');
            }
        });

        // Redirect root to static index.html if it exists, otherwise dashboard
        this.app.get('/', (req, res) => {
            const indexPath = path.join(process.cwd(), 'web', 'public', 'index.html');
            res.sendFile(indexPath, (err) => {
                if (err) {
                    logger.warn(`[Dashboard] index.html not found at ${indexPath}, redirecting to /dashboard`);
                    res.redirect('/dashboard');
                }
            });
        });

        // NEW: Portfolio Tracking API
        this.app.get('/api/tokens', async (req, res) => {
            try {
                const tokens = await this.storage.getAllTrackingTokens();
                res.json(tokens);
            } catch (error) {
                logger.error(`[API] /api/tokens error: ${error}`);
                res.status(500).json({ error: 'Internal Server Error' });
            }
        });
    }

    start() {
        const PORT = process.env.PORT || 8080; // Railway's dynamic port takes priority
        const host = '0.0.0.0'; // CRITICAL: Railway requires binding to 0.0.0.0, not localhost
        this.app.listen(Number(PORT), host, () => {
            logger.info(`[Dashboard] Server running on port ${PORT} (accessible via Railway domain)`);
        });
    }
}
