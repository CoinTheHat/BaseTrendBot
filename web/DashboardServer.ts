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
        // CRITICAL: Point to source directory since .ejs files aren't copied to dist by tsc
        const viewsPath = path.join(__dirname, '../../web/views');
        this.app.set('views', viewsPath);

        // Public static files (if needed)
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Routes
        this.setupRoutes();
    }

    private setupRoutes() {
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

        this.app.get('/', (req, res) => {
            res.redirect('/dashboard');
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
