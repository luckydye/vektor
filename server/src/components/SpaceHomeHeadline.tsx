import { type JSX, Show } from "solid-js";
import { useTranslation } from "#composeables/useTranslation.ts";
import type { Weather } from "#composeables/useWeather.ts";

interface Props {
  date: string;
  weather?: Weather;
  children?: JSX.Element;
}

export function SpaceHomeHeadline(props: Props) {
  const t = useTranslation();

  return (
    <header class="pt-4xs">
      <h1 class="font-medium text-neutral-800 text-size-display tracking-tight">
        {props.date}
      </h1>
      {/* Always rendered with one line's height: the weather loads late and must not push the page. */}
      <p class="mt-1 h-[1lh] text-neutral-500 text-size-medium tabular-nums">
        <Show when={props.weather}>
          {(weather) => (
            <>
              <span class="mr-1.5" aria-hidden="true">{weather().symbol}</span>
              {weather().temperature}° {t(weather().condition)}
              <span class="mx-2" aria-hidden="true">·</span>
              <span title={`${t("Low")} – ${t("High")}`}>
                {weather().low}–{weather().high}°
              </span>
              <span class="mx-2" aria-hidden="true">·</span>
              <span title={t("Chance of rain")}>
                {t("{percent}% rain").replace("{percent}", String(weather().precipitationChance))}
              </span>
            </>
          )}
        </Show>
      </p>
      {props.children}
    </header>
  );
}
