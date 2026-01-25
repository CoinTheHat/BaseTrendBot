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
        // Check deduplication
        const existing = this.items.find(i => i.phrase === phrase.toLowerCase());
        if (existing) return existing;

        const newItem: MemeWatchItem = {
            id: generateId(),
            phrase: phrase.toLowerCase(),
            tags: tags.map(t => t.toLowerCase()),
            createdAt: new Date()
        };
        this.items.push(newItem);

        // Persist
        await this.storage.addWatchItem(newItem);

        return newItem;
    }

    async removePhrase(idOrPhrase: string): Promise<boolean> {
        const startLen = this.items.length;
        this.items = this.items.filter(i => i.id !== idOrPhrase && i.phrase !== idOrPhrase.toLowerCase());
        const removed = this.items.length < startLen;

        if (removed) {
            await this.storage.removeWatchItem(idOrPhrase);
        }
        return removed;
    }
}
