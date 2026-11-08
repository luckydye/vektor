import type { ComponentProps } from "solid-js";
import { DesktopLogin } from "#components/DesktopLogin.tsx";

export type DesktopLoginPageProps = ComponentProps<typeof DesktopLogin>;

export function DesktopLoginPage(props: DesktopLoginPageProps) {
  return (
    <div class="flex min-h-screen items-center justify-center px-8 py-16">
      <DesktopLogin {...props} />
    </div>
  );
}
