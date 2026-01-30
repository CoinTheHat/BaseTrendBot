
import { exec } from 'child_process';
import util from 'util';
import dotenv from 'dotenv';
import path from 'path';

// Load Env
dotenv.config({ path: path.resolve(__dirname, '.env') });

const execAsync = util.promisify(exec);

async function testBird() {
    console.log("Starting Bird API Test...");

    const token = process.env.TWITTER_AUTH_TOKEN;
    const ct0 = process.env.TWITTER_CT0;

    if (!token || !ct0) {
        console.error("❌ Missing TWITTER_AUTH_TOKEN or TWITTER_CT0 in .env");
        return;
    }

    console.log(`Token provided: ${token.substring(0, 10)}...`);
    console.log(`CT0 provided: ${ct0.substring(0, 10)}...`);

    const query = "$SOL";
    const cmd = `npx @steipete/bird search "${query}" --count 5 --json`;

    const env = {
        ...process.env,
        AUTH_TOKEN: token,
        CT0: ct0
    };

    try {
        console.log(`Executing: ${cmd}`);
        console.time("BirdRequest");
        const { stdout, stderr } = await execAsync(cmd, { env, timeout: 15000 }); // 15s timeout for test
        console.timeEnd("BirdRequest");

        console.log("✅ Command executed successfully.");

        if (stderr) console.log("STDERR:", stderr);

        try {
            const data = JSON.parse(stdout);
            console.log("Response Type:", Array.isArray(data) ? "Array" : typeof data);
            console.log("Response Length:", Array.isArray(data) ? data.length : "N/A");

            if (Array.isArray(data) && data.length > 0) {
                console.log("Sample Tweet:", JSON.stringify(data[0], null, 2));
            } else {
                console.log("Full Output:", stdout);
            }

        } catch (e) {
            console.error("❌ Failed to parse JSON stdout:", e);
            console.log("Raw STDOUT:", stdout);
        }

    } catch (err: any) {
        console.timeEnd("BirdRequest");
        console.error("❌ Command Failed!");
        console.error("Error Message:", err.message);
        console.error("Exit Code:", err.code);
        if (err.stdout) console.log("Error STDOUT:", err.stdout);
        if (err.stderr) console.log("Error STDERR:", err.stderr);
    }
}

testBird();
