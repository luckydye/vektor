function routerRelativeUrl(target: URL, state: Record<string, unknown>): string {
  const current = state.current;
  if (typeof current !== "string") {
    return `${target.pathname}${target.search}${target.hash}`;
  }

  const currentRouterUrl = new URL(current, window.location.origin);
  const browserPath = window.location.pathname;
  const routerPath = currentRouterUrl.pathname;

  // Vue Router stores `history.state.current` relative to its history base.
  // Infer that base from the URL before replacing it so a space-scoped browser
  // URL such as `/team/doc/new` remains `/doc/new` in router state. Otherwise
  // the next router navigation prefixes `/team` again and Back returns to
  // `/team/team/doc/new`.
  const base =
    browserPath === routerPath
      ? ""
      : browserPath.endsWith(routerPath)
        ? browserPath.slice(0, -routerPath.length)
        : null;

  const targetPath =
    base === null || base === ""
      ? target.pathname
      : target.pathname === base
        ? "/"
        : target.pathname.startsWith(`${base}/`)
          ? target.pathname.slice(base.length)
          : target.pathname;

  return `${targetPath}${target.search}${target.hash}`;
}

export function replaceBrowserUrl(url: string | URL): void {
  const target = new URL(String(url), window.location.origin);
  const existingState = window.history.state as Record<string, unknown> | null;
  const state = existingState ?? {
    back: null,
    current: `${target.pathname}${target.search}${target.hash}`,
    forward: null,
    position: window.history.length - 1,
    replaced: true,
    scroll: null,
  };
  const current = routerRelativeUrl(target, state);

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
