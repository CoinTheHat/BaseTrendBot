import { MemeWatchItem } from '../models/types';
// import { v4 as uuidv4 } from 'uuid'; // Removed to avoid dependency

// Simple ID generator if uuid not available, but we likely installed dependencies.
// Actually uuid wasn't in the initial npm install list. I'll use a simple random string helper.

const generateId = () => Math.random().toString(36).substr(2, 9);

import { JsonStorage } from '../storage/JsonStorage';

export class MemeWatchlist {
    private items: MemeWatchItem[] = [];

    constructor(private storage: JsonStorage) {
        // Load initial state from storage
        const data = this.storage.load();
        this.items = data.watchlist || [];
    }

    getWatchlist(): MemeWatchItem[] {
        return this.items;
    }

    addPhrase(phrase: string, tags: string[] = []): MemeWatchItem {
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
        this.storage.updateWatchlist(this.items);

        return newItem;
    }

    removePhrase(idOrPhrase: string): boolean {
        const startLen = this.items.length;
        this.items = this.items.filter(i => i.id !== idOrPhrase && i.phrase !== idOrPhrase.toLowerCase());
        const removed = this.items.length < startLen;

        if (removed) {
            this.storage.updateWatchlist(this.items);
        }
        return removed;
    }
}
