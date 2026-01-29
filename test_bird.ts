
import { BirdService } from './twitter/BirdService';
import { config } from './config/env';
import * as dotenv from 'dotenv';
dotenv.config();

config.TWITTER_AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN || '';
config.TWITTER_CT0 = process.env.TWITTER_CT0 || '';

async function run() {
    console.log('Testing BirdService (Search)...');
    const bird = new BirdService();
    // Use a high-volume term to Ensure hits
    // Note: 'search' might be returning empty if no exact recent match in that endpoint?
    const results = await bird.search('crypto', 3);
    console.log(`Found ${results.length} tweets:`);
    results.forEach(t => {
        console.log(`[${t.author.screen_name}] (${t.likes} likes): ${t.text.substring(0, 50)}...`);
    });
}

run();
