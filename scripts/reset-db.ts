
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function resetDb() {
    try {
        console.log('🗑️  Clearing Database Tables...');
        const client = await pool.connect();

        // Order matters for foreign keys if any, but these seem independent mostly.
        const tables = [
            'seen_tokens',
            'token_performance',
            'trends',
            'keyword_alerts'
        ];

        for (const table of tables) {
            await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE;`);
            console.log(`✅ Table '${table}' cleared.`);
        }

        console.log('✨ Database reset complete! Watchlist was PRESERVED.');
        client.release();
        process.exit(0);
    } catch (err) {
        console.error('❌ Database reset failed:', err);
        process.exit(1);
    }
}

resetDb();
