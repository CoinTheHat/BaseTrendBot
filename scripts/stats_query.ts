import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();

    // 7 Days ago
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 7);
    const sinceISO = sinceDate.toISOString();

    console.log(`📊 Validating Stats since: ${sinceISO}`);

    const stats = await storage.getWeeklyStats();

    console.log('--- DB STATS ---');
    console.log(stats);

    process.exit(0);
}

main().catch(console.error);
