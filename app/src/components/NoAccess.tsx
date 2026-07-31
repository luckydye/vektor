import { arrowLeftIcon, lockElementIcon } from "#assets/icons.ts";
import { t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";

export function NoAccess() {
  return (
    <div class="flex h-full items-center justify-center bg-neutral-200">
      <div class="max-w-md px-6 py-12 text-center">
        <div class="mb-6">
          <div
            class="svg-icon mx-auto h-24 w-24 text-red-500"
            innerHTML={lockElementIcon}
          />
        </div>

        <h1 class="mb-4 font-bold text-neutral-900 text-size-display">
          {t("Access Denied")}
        </h1>

        <p class="mb-8 text-neutral-900 text-size-title">
          Sorry mate, you don't have permission to view this page. If you reckon this is a
          mistake, have a chat with your administrator.
        </p>

        <Button onClick={() => history.back()}>
          <div class="svg-icon mr-2 h-5 w-5" innerHTML={arrowLeftIcon} />
          Go Back
        </Button>
      </div>
    </div>
  );
}
