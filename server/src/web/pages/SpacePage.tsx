import type { ComponentProps } from "solid-js";
import { SpaceApp } from "#components/SpaceApp.tsx";

export type SpacePageProps = ComponentProps<typeof SpaceApp>;

export function SpacePage(props: SpacePageProps) {
  return <SpaceApp {...props} />;
}
