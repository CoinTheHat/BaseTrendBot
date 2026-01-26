import { MemeWatchItem } from '../models/types';
import { PostgresStorage } from '../storage/PostgresStorage';

const generateId = () => Math.random().toString(36).substr(2, 9);

export class MemeWatchlist {
    private items: MemeWatchItem[] = []; // In-memory cache

    constructor(private storage: PostgresStorage) { }

    async init() {
        this.items = await this.storage.getWatchlist();
    }

    getWatchlist(): MemeWatchItem[] {
        return this.items;
    }

    async addPhrase(phrase: string, tags: string[] = []): Promise<MemeWatchItem> {
        // Check deduplication (Exact match now, or should we be case-insensitive for dupe check? Let's use exact for flexibility)
        // If we want to prevent "Doge" and "doge", we could check lowercased, but then what if "Doge" is a CA (unlikely) vs "doge" keyword?
        // Better to allow duplicates if case differs if we support CAs.
        // Or better: Check if it LOOKS like a CA (Base58, long). If so, case sensitive. If not, case insensitive?
        // For simplicity: Store RAW. Deduplicate RAW.
        const existing = this.items.find(i => i.phrase === phrase);
        if (existing) return existing;

        const newItem: MemeWatchItem = {
            id: generateId(),
            phrase: phrase.trim(), // Keep Case!
            tags: tags.map(t => t.trim()), // Keep Case!
            createdAt: new Date()
        };
        this.items.push(newItem);

        // Persist
        await this.storage.addWatchItem(newItem);

        return newItem;
    }

    async removePhrase(idOrPhrase: string): Promise<boolean> {
        const startLen = this.items.length;
        // Match exact ID or exact Phrase
        this.items = this.items.filter(i => i.id !== idOrPhrase && i.phrase !== idOrPhrase);
        const removed = this.items.length < startLen;

        if (removed) {
            await this.storage.removeWatchItem(idOrPhrase);
        }
        return removed;
    }
}
