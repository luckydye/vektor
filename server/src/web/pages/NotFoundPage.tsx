import { t } from "#utils/lang.ts";

export interface NotFoundPageProps {
  lang: string;
}

export function NotFoundPage(props: NotFoundPageProps) {
  return (
    <>
      <main class="flex flex-col items-center justify-center min-h-screen gap-3 px-6 text-center text-neutral-500">
        <p class="text-2xl font-semibold text-neutral-800">404</p>
        <p>{t("Page not found.", props.lang)}</p>
        <a
          href="/"
          class="mt-3 text-primary-500 hover:underline"
          style="font-size: var(--text-size-medium)"
        >
          {t("Back to home", props.lang)}
        </a>
      </main>

      <footer
        class="fixed inset-x-0 bottom-0 flex justify-center py-5 text-neutral-400"
        style="font-size: var(--text-size-small)"
      >
        <a
          href="https://www.vektorapp.org/"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:text-neutral-600 transition-colors"
        >
          vektorapp.org
        </a>
      </footer>
    </>
  );
}
