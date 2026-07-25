/**
 * Loads X/Twitter's `widgets.js` once and exposes it for hydrating oEmbed
 * blockquotes into live tweet embeds. The server returns script-free oEmbed
 * markup (see `url-metadata.ts`), so the client owns loading the widget script
 * and calling `twttr.widgets.load(el)` on the container holding the blockquote.
 */

const WIDGETS_SRC = "https://platform.twitter.com/widgets.js";

interface TwitterWidgets {
  widgets: {
    load: (element?: HTMLElement) => Promise<void>;
  };
}

let widgetsPromise: Promise<TwitterWidgets> | null = null;

function existingWidgets(): TwitterWidgets | null {
  const twttr = (window as unknown as { twttr?: Partial<TwitterWidgets> }).twttr;
  return twttr?.widgets ? (twttr as TwitterWidgets) : null;
}

export function loadTwitterWidgets(): Promise<TwitterWidgets> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Twitter widgets unavailable in this environment"));
  }

  const ready = existingWidgets();
  if (ready) return Promise.resolve(ready);

  if (widgetsPromise) return widgetsPromise;

  widgetsPromise = new Promise<TwitterWidgets>((resolve, reject) => {
    const finish = () => {
      const twttr = existingWidgets();
      if (twttr) resolve(twttr);
      else reject(new Error("Twitter widgets failed to initialize"));
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${WIDGETS_SRC}"]`,
    );
    if (existingScript) {
      existingScript.addEventListener("load", finish, { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Twitter widgets failed to load")),
        { once: true },
      );
      // The script may already be loaded even without our listeners.
      if (existingWidgets()) finish();
      return;
    }

    const script = document.createElement("script");
    script.src = WIDGETS_SRC;
    script.async = true;
    script.charset = "utf-8";
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Twitter widgets failed to load")),
      { once: true },
    );
    document.head.appendChild(script);
  });

  // Allow a later retry if this attempt fails.
  widgetsPromise.catch(() => {
    widgetsPromise = null;
  });

  return widgetsPromise;
}
