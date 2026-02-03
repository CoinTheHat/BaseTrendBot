
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log("Searching for autopsy candidates (>24h)...");
        const res = await pool.query(`
            SELECT mint, symbol, alert_timestamp, status 
            FROM token_performance 
            WHERE alert_timestamp < NOW() - INTERVAL '24 hours'
            LIMIT 5
        `);

        if (res.rows.length === 0) {
            console.log("No candidates found > 24h old.");
        } else {
            console.log(`Found ${res.rows.length} candidates:`);
            console.table(res.rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

main();
