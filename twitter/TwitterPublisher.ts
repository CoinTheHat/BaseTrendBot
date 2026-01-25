import { TwitterApi } from 'twitter-api-v2';
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { Narrative, TokenSnapshot } from '../models/types';

export class TwitterPublisher {
    private client: TwitterApi | null = null;

    constructor() {
        if (config.ENABLE_TWITTER_ALERTS && config.TWITTER_API_KEY) {
            this.client = new TwitterApi({
                appKey: config.TWITTER_API_KEY,
                appSecret: config.TWITTER_API_SECRET,
                accessToken: config.TWITTER_ACCESS_TOKEN,
                accessSecret: config.TWITTER_ACCESS_SECRET,
            });
        }
    }

    async postTweet(narrative: Narrative, token: TokenSnapshot) {
        if (!this.client || !config.ENABLE_TWITTER_ALERTS) return;

        const tweetText =
            `SPOTTED 🛸
${narrative.narrativeText.split('.')[0]}.
Sol just printed: $${token.symbol}

MC: $${(token.marketCapUsd || 0 / 1000).toFixed(1)}k
Liq: $${(token.liquidityUsd || 0 / 1000).toFixed(1)}k

${narrative.vibeCheck}

#solana #memecoin $${token.symbol}`;

        try {
            await this.client.v2.tweet(tweetText);
            logger.info(`[Twitter] Tweet posted for ${token.symbol}`);
        } catch (err) {
            logger.error(`[Twitter] Failed to tweet: ${err}`);
        }
    }
}
