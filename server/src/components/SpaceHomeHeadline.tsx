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
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p class="font-semibold text-neutral-500 text-size-small uppercase tracking-[0.12em] dark:text-neutral-400">
          {props.date}
        </p>
        <Show when={props.weather}>
          {(weather) => (
            <p class="text-neutral-500 text-size-small tabular-nums dark:text-neutral-400">
              {weather().temperature}° {t(weather().condition)}
              <span class="mx-2" aria-hidden="true">·</span>
              <span title={`${t("Low")} – ${t("High")}`}>
                {weather().low}–{weather().high}°
              </span>
              <span class="mx-2" aria-hidden="true">·</span>
              <span title={t("Chance of rain")}>
                {t("{percent}% rain").replace("{percent}", String(weather().precipitationChance))}
              </span>
            </p>
          )}
        </Show>
      </div>
      {props.children}
    </header>
  );
}
