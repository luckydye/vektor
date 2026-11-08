// Doc content is rendered inside a declarative shadow root, so heading ids
// (and thus native #anchor scrolling) aren't reachable via document.getElementById —
// resolve and scroll to them manually instead.
function contentRoot() {
  return document.querySelector("docs-content")?.shadowRoot ?? null;
}

function scrollToHash(hash: string) {
  const id = hash.replace(/^#/, "");
  if (!id) return;
  contentRoot()
    ?.getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
  if (!link) return;
  const hash = link.getAttribute("href") ?? "";
  if (hash.length < 2) return;

  event.preventDefault();
  history.pushState(null, "", hash);
  scrollToHash(hash);
});

if (location.hash) {
  requestAnimationFrame(() => scrollToHash(location.hash));
}

/**
 * Marks the outline entry for the section the reader is in. Driven by scroll
 * position rather than IntersectionObserver — with headings this close together
 * several are on screen at once, and "the last one passed" is the answer a
 * reader expects.
 */
function trackOutline() {
  const root = contentRoot();
  const links = [...document.querySelectorAll(".docs-nav-outline-link")];
  if (!root || links.length === 0) return;

  // The outline is rendered twice — sticky sidebar and mobile disclosure — so a
  // heading is tracked once and every link pointing at it is marked together.
  const entries = [...new Set(links.map((link) => link.getAttribute("href") ?? ""))]
    .map((href) => ({ href, heading: root.getElementById(href.slice(1)) }))
    .filter((entry): entry is { href: string; heading: HTMLElement } => !!entry.heading);

  if (entries.length === 0) return;

  /** Keeps the marked entry visible without scrolling the page with it. */
  const revealInNav = () => {
    const link = document.querySelector('.docs-nav [aria-current="true"]');
    const nav = link?.closest(".docs-nav");
    if (!link || !nav) return;
    const bounds = nav.getBoundingClientRect();
    const entry = link.getBoundingClientRect();
    if (entry.top < bounds.top) nav.scrollTop -= bounds.top - entry.top + 16;
    else if (entry.bottom > bounds.bottom) {
      nav.scrollTop += entry.bottom - bounds.bottom + 16;
    }
  };

  let frame = 0;
  let marked: string | null = null;
  const update = () => {
    frame = 0;
    // The sticky header's height, so a heading tucked under it doesn't count.
    const cutoff = 96;
    let active = entries[0].href;
    for (const entry of entries) {
      if (entry.heading.getBoundingClientRect().top <= cutoff) active = entry.href;
    }
    if (active === marked) return;
    marked = active;

    for (const link of links) {
      const isActive = link.getAttribute("href") === active;
      if (isActive) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }

    revealInNav();
  };

  addEventListener(
    "scroll",
    () => {
      if (!frame) frame = requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

trackOutline();

export {};
