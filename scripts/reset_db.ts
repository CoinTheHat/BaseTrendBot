
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env from root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function resetDb() {
    console.log('🗑️  Starting Database Reset...');

    try {
        const client = await pool.connect();
        try {
            // Truncate Tables
            const tables = ['seen_tokens', 'token_performance', 'trends', 'keyword_alerts']; // Add others if needed

            for (const table of tables) {
                console.log(`   - Truncating ${table}...`);
                // Use TRUNCATE for fast clean. 
                // IF EXISTS checks avoid error if table doesn't exist yet (though it should)
                await client.query(`TRUNCATE TABLE ${table} CASCADE;`);
            }

            console.log('✅ Database Cleared Successfully!');
        } finally {
            client.release();
        }
    } catch (err: any) {
        console.error('❌ Reset Failed:', err.message);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

resetDb();
