/**
 * Simple LRU (Least Recently Used) cache implementation with a fixed capacity.
 * When the cache is full, the least recently used item is evicted.
 */
export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error("LRU cache capacity must be positive");
    }
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Get a value from the cache. Updates access order.
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used)
    const value = this.cache.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Set a value in the cache. Evicts LRU item if at capacity.
   */
  set(key: K, value: V): void {
    // If key exists, delete it first so we can re-add at the end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value as K;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Check if a key exists in the cache without updating access order.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get current size of the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
