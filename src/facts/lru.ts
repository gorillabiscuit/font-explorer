/**
 * A Map that forgets its least recently used entry once it holds more than `limit`.
 * DOM-free, so the font byte cache, the parsed-font cache and the measurers can all share it.
 * `keep` names entries that must not be forgotten yet (a face a mounted card still shows); while
 * those fill the map it may grow past `limit`, and later inserts shrink it back once they are let go.
 */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private limit: number, private keep?: (key: K) => boolean) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-inserting moves the key to the end, which is the "most recent" end of a Map's order.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size <= this.limit) return;
    // Forget from the least recently used end, stepping over kept entries. Deleting the key being
    // visited is safe while iterating a Map.
    for (const k of this.map.keys()) {
      if (this.map.size <= this.limit) break;
      if (!this.keep?.(k)) this.map.delete(k);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
