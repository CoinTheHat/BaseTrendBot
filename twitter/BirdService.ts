import { exec } from 'child_process';
import util from 'util';
import { logger } from '../utils/Logger';
import { twitterAccountManager } from './TwitterAccountManager';

const execAsync = util.promisify(exec);

export interface BirdTweet {
    id: string;
    text: string;
    author: {
        name: string;
        screen_name: string;
        avatar?: string;
    };
    created_at: string;
    views?: number;
    likes?: number;
    retweets?: number;
    url: string;
}

export class BirdService {

    /**
     * Executes bird CLI search command
     */
    async search(query: string, limit: number = 20): Promise<BirdTweet[]> {
        const account = twitterAccountManager.getNextAccount();

        if (!account) {
            logger.warn('[Bird] No Twitter accounts available active in pool. Skipping.');
            return [];
        }

        // Prepare Env with Tokens from the rotated account
        const env = {
            ...process.env,
            AUTH_TOKEN: account.authToken,
            CT0: account.ct0
        };

        // Log rotation (Optional, but good for debug)
        // logger.info(`[Bird] using Account #${account.index + 1}`); 

        // Escape inner double quotes AND dollar signs to prevent shell issues
        const safeQuery = query.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        const cmd = `npx @steipete/bird search "${safeQuery}" --count ${limit} --json`;

        try {
            logger.info(`[Bird] Searching: ${query} (Account #${account.index + 1})`);
            const { stdout } = await execAsync(cmd, { env, timeout: 10000 });

            try {
                // Parse JSON output
                const rawData = JSON.parse(stdout);

                // Debug: Log what we got
                logger.debug(`[Bird] RAW Output Length: ${stdout.length}. Is Array? ${Array.isArray(rawData)}.`);

                if (!Array.isArray(rawData)) {
                    logger.warn(`[Bird] Unexpected JSON structure: ${stdout.substring(0, 200)}`);
                    return [];
                }

                return rawData.map((t: any) => {
                    // Mapping based on bird JSON schema
                    // Note: with --json-full, raw object might be under _raw or explicit fields.
                    // The standard fields usually match the observed output (createdAt, likeCount).

                    // Fallback to _raw if standard fields miss info (like avatar)
                    // _raw usually contains the GraphQL legacy style object
                    const rawUser = t._raw?.core?.user_results?.result?.legacy || t.author;
                    const avatar = rawUser?.profile_image_url_https || t.author?.profile_image_url || '';

                    return {
                        id: t.id,
                        text: t.text,
                        author: {
                            name: t.author?.name || 'Unknown',
                            screen_name: t.author?.username || 'unknown',
                            avatar: avatar
                        },
                        created_at: t.createdAt,
                        views: t.viewCount || t.views, // Check availability
                        likes: t.likeCount,
                        retweets: t.retweetCount,
                        url: `https://x.com/${t.author?.username}/status/${t.id}`
                    };
                });

            } catch (jsonErr) {
                logger.error(`[Bird] Failed to parse JSON: ${jsonErr}`);
                return [];
            }

        } catch (err: any) {
            // Enhanced Error Logging for Diagnostics
            // logger.error(`[Bird] Command failed: ${err.message || err.toString()}`);

            // Try to extract status code if embedded in message or props
            const status = err.code || err.status || 'Unknown';
            const msg = err.message || err.toString();

            // Log detailed error info
            // if (err.response) {
            //     logger.error(`[Bird API Status] Code: ${err.response.status}`);
            // }

            // Log stdout/stderr if available (CLI errors)
            if (err.stdout) logger.warn(`[Bird STDOUT]: ${err.stdout.substring(0, 200)}`);
            // if (err.stderr) logger.error(`[Bird STDERR]: ${err.stderr.substring(0, 200)}`);

            // Special handling for rate limits or auth errors
            if (msg.includes('429')) {
                logger.warn(`[Bird] ⚠️ RATE LIMIT (429) on Account #${account.index + 1}.`);
            } else if (msg.includes('401')) {
                logger.warn(`[Bird] ⚠️ UNAUTHORIZED (401) on Account #${account.index + 1}. Check credentials.`);
            } else {
                logger.error(`[Bird] Error Code: ${status} on Account #${account.index + 1}`);
            }

            return [];
        }
    }
}
