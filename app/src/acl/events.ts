export type AuthorizationChange =
  | { spaceId: string; userId?: never }
  | { userId: string; spaceId?: never };

const listeners = new Set<(change: AuthorizationChange) => void>();

export function publishAuthorizationChange(change: AuthorizationChange): void {
  for (const listener of listeners) listener(change);
}

export function subscribeToAuthorizationChanges(
  listener: (change: AuthorizationChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
