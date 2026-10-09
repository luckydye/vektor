/**
 * A bounded memo that evicts the least recently used entry, so a canvas with
 * more shapes than the bound still hits for everything on screen.
 */
export function remembered<K, V>(
  cache: Map<K, V>,
  key: K,
  capacity: number,
  create: () => V,
): V {
  if (cache.has(key)) {
    const value = cache.get(key) as V;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  const value = create();
  cache.set(key, value);
  if (cache.size > capacity) cache.delete(cache.keys().next().value as K);
  return value;
}
