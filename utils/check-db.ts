const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

async function checkDB() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    });
    try {
        await client.connect();
        const res = await client.query('SELECT * FROM maturation_records LIMIT 10;');
        console.log('--- Maturation Records ---');
        console.table(res.rows);

        const res2 = await client.query('SELECT COUNT(*) FROM maturation_records;');
        console.log(`Total Records: ${res2.rows[0].count}`);
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkDB();
