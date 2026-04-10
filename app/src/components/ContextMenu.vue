<script setup lang="ts">
import "@sv/elements/popover";
import "@sv/elements/list";
import ButtonSecondary from "./ButtonSecondary.vue";
import Icon from "./Icon.vue";

function handleSubmit(e: CustomEvent<{ detail: { selected: HTMLElement } }>) {
  e.detail.selected?.querySelector("button")?.click();
}
</script>

<template>
  <a-popover-trigger class="group relative z-10">
    <ButtonSecondary slot="trigger" aria-label="Document actions">
        <Icon name="more" />
    </ButtonSecondary>

    <a-popover class="group" placements="bottom-end">
      <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
        <div class="min-w-[100px] bg-background border border-neutral-100 rounded-lg p-5xs origin-top-right scale-95 transition-all shadow-large duration-150 group-[&[enabled]]:scale-100">
          <a-list @change="handleSubmit" class="max-h-screen min-w-[150px] w-full overflow-auto text-interactive outline-none space-y-5xs">
            <slot></slot>
          </a-list>
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>
