
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function migrate() {
    try {
        console.log('Starting migration for Multi-Trade Support...');

        // 1. Drop existing Primary Key Constraint on mint
        await pool.query(`ALTER TABLE token_performance DROP CONSTRAINT token_performance_pkey;`);
        console.log('Dropped PK on mint.');

        // 2. Add new ID column and make it PK
        // Note: If table has data, this adds unique IDs automatically.
        await pool.query(`ALTER TABLE token_performance ADD COLUMN id SERIAL PRIMARY KEY;`);
        console.log('Added id column as Primary Key.');

        // 3. Add Index on mint for performance lookup
        await pool.query(`CREATE INDEX idx_performance_mint ON token_performance(mint);`);
        console.log('Added index on mint.');

        console.log('Migration successful.');
    } catch (err: any) {
        console.error('Migration failed:', err.message);
    } finally {
        await pool.end();
    }
}

migrate();
