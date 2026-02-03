import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('DATABASE_URL is not set in .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function clearDb() {
    try {
        console.log('Connecting to database...');
        const client = await pool.connect();

        console.log('Clearing "seen_tokens"...');
        await client.query('TRUNCATE TABLE seen_tokens CASCADE');

        console.log('Clearing "token_performance"...');
        await client.query('TRUNCATE TABLE token_performance CASCADE');

        console.log('Clearing "trends"...');
        await client.query('TRUNCATE TABLE trends CASCADE');

        console.log('Clearing "keyword_alerts"...');
        await client.query('TRUNCATE TABLE keyword_alerts CASCADE');

        console.log('✅ Database tokens cleared successfully.');
        client.release();
    } catch (err) {
        console.error('❌ Error clearing database:', err);
    } finally {
        await pool.end();
    }
}

clearDb();
