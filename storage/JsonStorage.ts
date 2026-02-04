import fs from 'fs';
import path from 'path';
import { MemeWatchItem } from '../models/types';

interface StorageData {
    watchlist: MemeWatchItem[];
    seenTokens: Record<string, SeenTokenData>;
}

export interface SeenTokenData {
    symbol?: string; // New: For Dashboard display if performance record missing
    firstSeenAt: number;
    lastAlertAt: number;
    lastScore: number;
    lastPhase: string;
    lastPrice?: number;
    dipTargetMc?: number;       // For Dip Entry
    storedAnalysis?: string;    // For Dip Entry
    rawSnapshot?: any;          // AI Training Data (Full Token Object)
}

export class JsonStorage {
    private filePath: string;

    constructor() {
        this.filePath = path.resolve(__dirname, '../../data.json');
        // Ensure file exists
        if (!fs.existsSync(this.filePath)) {
            this.save({ watchlist: [], seenTokens: {} });
        }
    }

    load(): StorageData {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw);
        } catch (err) {
            console.error('[Storage] Read error, returning empty state', err);
            return { watchlist: [], seenTokens: {} };
        }
    }

    save(data: StorageData) {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('[Storage] Save error', err);
        }
    }

    // Helpers usually managed by CooldownManager or Watchlist, 
    // but we can expose direct save/load or specialized methods here.

    updateWatchlist(items: MemeWatchItem[]) {
        const data = this.load();
        data.watchlist = items;
        this.save(data);
    }

    updateSeenToken(mint: string, tokenData: SeenTokenData) {
        const data = this.load();
        data.seenTokens[mint] = tokenData;
        this.save(data);
    }
}
