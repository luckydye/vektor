import { useTranslation } from "#composeables/useTranslation.ts";
import type { NativeApp } from "#utils/nativeApp.ts";

interface Props {
  app: NativeApp;
}

/** Preferences that only exist inside the desktop app. */
export function DesktopAppPreferences(props: Props) {
  const t = useTranslation();

  return (
    <section>
      <div class="mb-3">
        <h2 class="font-semibold text-foreground text-size-medium">{t("Desktop App")}</h2>
        <p class="mt-1 text-neutral-500 text-size-small">
          {t("Settings for the Vektor app on this device.")}
        </p>
      </div>
      <div class="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-background p-3">
        <p class="font-medium text-foreground text-size-small">{t("Version")}</p>
        <p class="text-label text-neutral-500">
          {props.app.version} · {props.app.platform}
        </p>
      </div>
      <div class="mt-3 rounded-lg border border-neutral-200 border-dashed p-5 text-center text-neutral-500 text-size-small">
        {t("More desktop options are coming soon.")}
      </div>
    </section>
  );
}
