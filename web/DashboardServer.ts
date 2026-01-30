import express from 'express';
import path from 'path';
import { PostgresStorage } from '../storage/PostgresStorage';
import { logger } from '../utils/Logger';

export class DashboardServer {
    private app;
    private port;

    constructor(private storage: PostgresStorage, port: number = 3000) {
        this.app = express();
        this.port = process.env.PORT || port;

        // Setup EJS
        this.app.set('view engine', 'ejs');
        this.app.set('views', path.join(__dirname, 'views'));

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
        this.app.listen(this.port, () => {
            logger.info(`[Dashboard] Server running at http://localhost:${this.port}/dashboard`);
        });
    }
}
