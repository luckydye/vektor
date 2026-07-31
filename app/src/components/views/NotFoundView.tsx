import { usePageTitle } from "#composeables/usePageTitle.ts";

export function NotFoundView() {
  usePageTitle("Not found");

  return (
    <>
      <div class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-neutral-500">
        <p class="font-semibold text-2xl text-neutral-800">404</p>
        <p>Page not found.</p>
      </div>

      <footer
        class="fixed inset-x-0 bottom-0 flex justify-center py-5 text-neutral-400"
        style={{ "font-size": "var(--text-size-small)" }}
      >
        <a
          href="https://www.vektorapp.org/"
          target="_blank"
          rel="noopener noreferrer"
          class="transition-colors hover:text-neutral-600"
        >
          vektorapp.org
        </a>
      </footer>
    </>
  );
}
