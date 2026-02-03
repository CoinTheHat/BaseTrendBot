
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
        // Get the 2nd best token
        const res = await pool.query(`
            SELECT mint, symbol, alert_timestamp 
            FROM token_performance 
            ORDER BY (ath_mc / NULLIF(alert_mc, 0)) DESC 
            OFFSET 1 LIMIT 1
        `);

        if (res.rows.length === 0) {
            console.log("No second token found.");
        } else {
            const t = res.rows[0];
            console.log(`TOKEN: ${t.symbol}`);
            console.log(`MINT: ${t.mint}`);
            console.log(`TIME: ${new Date(t.alert_timestamp).toISOString()}`);
        }
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

main();
