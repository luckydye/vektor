import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { LocaleContext } from "#composeables/useTranslation.ts";

/** `render` inside the locale provider that `SpaceApp`/`SpacesApp` mount in the app. */
export function renderWithLocale(code: () => JSX.Element, host: HTMLElement) {
  return render(
    () => <LocaleContext.Provider value="en">{code()}</LocaleContext.Provider>,
    host,
  );
}
