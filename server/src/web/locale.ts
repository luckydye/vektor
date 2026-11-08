import { FALLBACK_LANG, normalizeLang, SUPPORTED_LANGS } from "#utils/lang.ts";

/**
 * The language an `Accept-Language` header prefers among those the app has a
 * catalogue for: highest quality first, regions folded into their language
 * (`de-AT` is `de`), `en` when nothing listed is supported.
 */
export function preferredLang(header: string | null | undefined): string {
  const candidates = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [range = "", ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=([\d.]+)$/)?.[1])
        .find((value) => value !== undefined);
      return {
        lang: normalizeLang(range.trim().toLowerCase()),
        quality: quality === undefined ? 1 : Number(quality),
        index,
      };
    })
    .filter((candidate) => candidate.quality > 0 && SUPPORTED_LANGS.includes(candidate.lang))
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  return candidates[0]?.lang ?? FALLBACK_LANG;
}
