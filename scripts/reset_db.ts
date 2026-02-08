import { Pool } from 'pg';
import { config } from '../config/env';

async function reset() {
    console.log('🗑️  Starting Clean Database Reset...');

    if (!config.DATABASE_URL) {
        console.error('❌ Error: DATABASE_URL not found.');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: config.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();
        const tables = [
            'token_performance',
            'seen_tokens',
            'trends',
            'keyword_alerts',
            'maturation_records',
            'watchlist'
        ];

        console.log(`🧹 Truncating tables: ${tables.join(', ')}`);
        await client.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE;`);

        console.log('✅ Database Wiped Successfully.');
        client.release();
    } catch (err) {
        console.error('❌ Reset Failed:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

reset();
