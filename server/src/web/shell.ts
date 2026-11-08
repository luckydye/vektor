import { generatePaletteCss } from "#utils/color.ts";
import { escapeHtml } from "#utils/html.ts";
import { THEME_COLORS } from "#utils/themePreference.ts";
import { PAGE_DATA_ID, PAGE_ROOT_ID, type PageName } from "./pages.ts";

export interface DocumentOptions {
  /** `app` is the full application chrome; `landing` is the bare page behind login and docs. */
  variant: "app" | "landing";
  lang: string;
  title: string;
  /** The page's markup, already rendered. */
  body: string;
  /** Which page this is, for the browser entry to load the matching code. */
  page: PageName;
  /** Script and link tags for the page's browser code. */
  assetTags: string;
  /** Runs before the entry to prepare hydration. */
  hydrationScript: string;
  /** What the browser hydrates the page with; absent for a static page. */
  pageProps?: unknown;
  publicEnv: App.PublicEnv;
  /** The space's brand color, which re-tints the palette. */
  brandColor?: string;
  spaceId?: string;
  /** Development serves the dev favicon and manifest. */
  dev: boolean;
}

/**
 * JSON for a `<script type="application/json">`, which ends at the first
 * `</script>` it contains. Escaping `<` keeps a value from closing it early.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

function brandStyles(brandColor: string): string {
  const palette = generatePaletteCss(brandColor);
  return `
    :root { --color-primary: ${brandColor}; ${palette.light} }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme]) body { --color-primary: ${brandColor}; ${palette.dark} }
    }
    :root[data-theme="dark"] body { --color-primary: ${brandColor}; ${palette.dark} }
    :root[data-theme="light"] body { --color-primary: ${brandColor}; ${palette.light} }
  `;
}

function head(options: DocumentOptions): string {
  const { variant, dev } = options;
  const favicon = (suffix: "light" | "dark") =>
    `/favicon_${dev ? "dev" : suffix}.png`;
  const tags = [
    `<meta charset="utf-8">`,
    `<link rel="icon" type="image/png" href="${favicon("light")}" media="(prefers-color-scheme: dark)">`,
    `<link rel="icon" type="image/png" href="${favicon("dark")}" media="(prefers-color-scheme: light)">`,
    variant === "app"
      ? `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
      : `<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<script type="application/json" id="env">${jsonForScript(options.publicEnv)}</script>`,
  ];

  if (variant === "app") {
    tags.push(
      `<link rel="manifest" href="${dev ? "/manifest.dev.json" : "/manifest.json"}">`,
      `<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">`,
    );
    if (options.brandColor) {
      tags.push(`<style>${brandStyles(options.brandColor)}</style>`);
    }
  }

  tags.push(options.hydrationScript, options.assetTags);
  return tags.join("\n    ");
}

/** The whole HTML document around a rendered page. */
export function renderDocument(options: DocumentOptions): string {
  const app = options.variant === "app";
  const spaceAttribute = app ? ` data-space-id="${escapeHtml(options.spaceId ?? "")}"` : "";
  const dataScript = `<script type="application/json" id="${PAGE_DATA_ID}">${jsonForScript({ page: options.page, props: options.pageProps })}</script>`;

  return `<!doctype html>
<html lang="${escapeHtml(options.lang)}">
  <head>
    ${head(options)}
  </head>
  <body class="bg-background font-sans"${spaceAttribute}>
    ${app ? `<title-bar aria-hidden="true"></title-bar>` : ""}
    <div id="${PAGE_ROOT_ID}" style="display: contents">${options.body}</div>
    ${dataScript}
  </body>
</html>
`;
}
