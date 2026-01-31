import { PostgresStorage } from '../storage/PostgresStorage';

async function hardReset() {
    console.log('💀 INITIATING HARD RESET (THE PURGE) 💀');

    const db = new PostgresStorage();
    await db.connect();

    // Use a raw client via the pool logic if possible, or just add a method to PostgresStorage.
    // Since `pool` is private, we'll check if we need to modify PostgresStorage or if we can extend it. 
    // Actually, cleanArchitecture suggests adding a method 'auditClearAll' to PostgresStorage 
    // BUT user asked for a script.
    // Let's modify PostgresStorage to expose a `resetAllData` method or just use a new instance of Pool here for simplicity if needed.
    // However, simplest way is to add a helper method to PostgresStorage.ts temporarily or just use pg directly here.

    // Let's use `pg` directly to avoid modifying the class just for a script.
    const { Pool } = require('pg');
    const { config } = require('../config/env');

    const pool = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: config.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        console.log('🗑️  Truncating Tables...');
        await client.query('TRUNCATE TABLE token_performance, seen_tokens, cool_downs CASCADE;');

        console.log('✅ System Wiped for Sniper Mode Test.');
        client.release();
    } catch (err) {
        console.error('❌ Reset Failed:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

hardReset();
