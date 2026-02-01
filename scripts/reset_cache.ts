import { Pool } from 'pg';
import { config } from '../config/env';

async function resetCache() {
    const pool = new Pool({ connectionString: config.DATABASE_URL });

    try {
        console.log('🔄 Connecting to database...');
        await pool.connect();

        console.log('🗑️  Clearing seen_tokens table...');
        const seenResult = await pool.query('DELETE FROM seen_tokens');
        console.log(`   ✅ Deleted ${seenResult.rowCount} rows from seen_tokens`);

        console.log('🗑️  Clearing token_performance table...');
        const perfResult = await pool.query('DELETE FROM token_performance');
        console.log(`   ✅ Deleted ${perfResult.rowCount} rows from token_performance`);

        console.log('\n✅ Cache reset complete! Bot will start fresh on next scan.');
    } catch (err) {
        console.error('❌ Reset failed:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

resetCache();
