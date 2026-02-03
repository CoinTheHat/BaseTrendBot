
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log("Searching for gems...");
        const res = await pool.query(`
            SELECT mint, symbol, alert_mc, ath_mc, alert_timestamp, entry_price 
            FROM token_performance 
            ORDER BY (ath_mc / NULLIF(alert_mc, 0)) DESC 
            LIMIT 1
        `);

        if (res.rows.length === 0) {
            console.log("No tokens found in database.");
        } else {
            const t = res.rows[0];
            const x = t.alert_mc > 0 ? (t.ath_mc / t.alert_mc).toFixed(2) : "0";
            console.log(`FOUND_GEM: ${t.symbol}`);
            console.log(`CA: ${t.mint}`);
            console.log(`TIME: ${new Date(t.alert_timestamp).toISOString()}`);
            console.log(`ENTRY_MC: $${Math.floor(t.alert_mc)}`);
            console.log(`ATH_MC: $${Math.floor(t.ath_mc)}`);
            console.log(`PERF: ${x}x`);
        }
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

main();
