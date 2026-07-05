export type VektorDocumentAddress = string;

export type ParsedVektorDocumentAddress = {
  address: VektorDocumentAddress;
  origin: string;
  spaceId: string;
  documentId: string;
  href?: string;
};

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function createVektorDocumentAddress(input: {
  origin: string;
  spaceId: string;
  documentId: string;
  href?: string | null;
}): VektorDocumentAddress {
  const origin = new URL(input.origin);
  const scheme = origin.protocol === "http:" ? "vektor+http:" : "vektor+https:";
  const address = new URL(`${scheme}//${origin.host}/`);
  address.pathname = `/${encodeURIComponent(input.spaceId)}/${encodeURIComponent(
    input.documentId,
  )}`;
  if (input.href) address.searchParams.set("href", input.href);
  return address.toString();
}

export function parseVektorDocumentAddress(
  address: string | null | undefined,
): ParsedVektorDocumentAddress | null {
  if (!address) return null;

  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }

  const originScheme =
    parsed.protocol === "vektor+http:"
      ? "http:"
      : parsed.protocol === "vektor+https:"
        ? "https:"
        : null;
  if (!originScheme || !parsed.host) return null;

  const pathParts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(safeDecodeURIComponent);
  if (pathParts.some((part) => part === null)) return null;

  const [spaceId, documentId] = pathParts as string[];
  if (!spaceId || !documentId) return null;

  const href = parsed.searchParams.get("href") || undefined;
  return {
    address: parsed.toString(),
    origin: `${originScheme}//${parsed.host}`,
    spaceId,
    documentId,
    ...(href ? { href } : {}),
  };
}

export function vektorDocumentAddressOrigin(address: string | undefined): string | null {
  return parseVektorDocumentAddress(address)?.origin ?? null;
}
