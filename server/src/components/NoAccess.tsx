import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

export function NoAccess() {
  const t = useTranslation();

  return (
    <div class="flex h-full items-center justify-center bg-neutral-200">
      <div class="max-w-md px-6 py-12 text-center">
        <div class="mb-6">
          <Icon class="mx-auto h-24 w-24 text-red-500" name="lock-element" />
        </div>

        <h1 class="mb-4 font-bold text-neutral-900 text-size-display">
          {t("Access Denied")}
        </h1>

        <p class="mb-8 text-neutral-900 text-size-title">
          Sorry mate, you don't have permission to view this page. If you reckon this is a
          mistake, have a chat with your administrator.
        </p>

        <Button onClick={() => history.back()}>
          <Icon class="mr-2 h-5 w-5" name="arrow-left" />
          Go Back
        </Button>
      </div>
    </div>
  );
}
