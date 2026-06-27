export function replaceBrowserUrl(url: string | URL): void {
  const target = new URL(String(url), window.location.origin);
  const current = `${target.pathname}${target.search}${target.hash}`;
  const state = window.history.state ?? {
    back: null,
    current,
    forward: null,
    position: window.history.length - 1,
    replaced: true,
    scroll: null,
  };

  window.history.replaceState(
    {
      ...state,
      current,
      replaced: true,
    },
    "",
    url,
  );
}
