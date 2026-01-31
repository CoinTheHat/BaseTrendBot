import { Pool } from 'pg';
import { config } from '../config/env';

async function simpleReset() {
    console.log('🧹 STARTING SIMPLE RESET...');

    if (!config.DATABASE_URL) {
        console.error('❌ DATABASE_URL missing!');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        console.log('🗑️ Deleting Tweets...');
        await client.query('DELETE FROM keyword_tweets');
        await client.query('DELETE FROM tweets'); // If exists

        console.log('🗑️ Deleting Tokens...');
        await client.query('DELETE FROM token_performance');
        await client.query('DELETE FROM seen_tokens');

        console.log('🗑️ Deleting History/Cooldowns...');
        await client.query('DELETE FROM cooldowns');

        console.log('✅ DATABASE WIPED CLEAN (Simple Mode).');
        client.release();
    } catch (err) {
        console.error('❌ Reset Failed:', err);
    } finally {
        await pool.end();
    }
}

simpleReset();
