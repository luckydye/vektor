import { useNavigate } from "@solidjs/router";
import { createEffect } from "solid-js";
import { canAccessSettings, Permission } from "#acl/permissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { SPACE_SETTINGS_DESTINATIONS } from "#utils/spaceSettingsDestinations.ts";

/**
 * A command palette action per place in the space settings — "Settings: AI
 * Runners" — for the settings the current user may open.
 */
export function useSpaceSettingsActions() {
  const t = useTranslation();
  const navigate = useNavigate();
  const { currentSpace } = useSpace();

  createEffect(() => {
    const role = currentSpace()?.userRole;
    if (!canAccessSettings(role)) return;
    const isOwner = role === Permission.OWNER;

    for (const destination of SPACE_SETTINGS_DESTINATIONS) {
      if (destination.ownerOnly && !isOwner) continue;
      registerScopedAction(`settings:open:${destination.id}`, {
        title: `${t("Settings")}: ${t(destination.title)}`,
        description: t(destination.description),
        group: "settings",
        run: async () => navigate(`/settings#${destination.id}`),
      });
    }
  });
}
