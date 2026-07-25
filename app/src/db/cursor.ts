/**
 * Encodes a keyset pagination cursor as the (sort timestamp, id) position of
 * the last row returned. Shared by any list endpoint that seeks on
 * `ORDER BY someTimestamp DESC, id DESC` for a stable, index-friendly cursor.
 */
export function encodeSeekCursor(t: number, id: string | number): string {
  return Buffer.from(JSON.stringify({ t, id })).toString("base64url");
}

export function decodeSeekCursor(
  cursor: string,
  idType: "string" | "number",
): { t: number; id: string | number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.t !== "number" || typeof parsed.id !== idType) return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}
