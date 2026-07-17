<script setup lang="ts">
import { t } from "#utils/lang.ts";
import { arrowLeftIcon, lockElementIcon } from "~/src/assets/icons.ts";
import { ButtonPrimary } from "~/src/components/index.ts";

function goBack() {
  history.back();
}
</script>

<template>
  <div class="flex items-center h-full justify-center bg-neutral-200">
    <div class="text-center px-6 py-12 max-w-md">
      <div class="mb-6">
        <div class="svg-icon mx-auto h-24 w-24 text-red-500" v-html="lockElementIcon" />
      </div>

      <h1 class="text-size-display font-bold text-neutral-900 mb-4">
        {{ t("Access Denied") }}
      </h1>

      <p class="text-size-title text-neutral-900 mb-8">
        Sorry mate, you don't have permission to view this page. If you reckon this is a
        mistake, have a chat with your administrator.
      </p>

      <ButtonPrimary @click="goBack">
        <div class="svg-icon w-5 h-5 mr-2" v-html="arrowLeftIcon" />
        Go Back
      </ButtonPrimary>
    </div>
  </div>
</template>
