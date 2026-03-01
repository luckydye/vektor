<script setup lang="ts">
import { ButtonPrimary } from "~/src/components/index.ts";
import { useTranslations } from "../composeables/useTranslations.ts";

function goBack() {
  history.back();
}

const t = useTranslations();
</script>

<template>
  <div class="flex items-center h-full justify-center bg-neutral-200">
    <div class="text-center px-6 py-12 max-w-md">
      <div class="mb-6">
        <svg
          class="mx-auto h-24 w-24 text-red-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </div>

      <h1 class="text-3xl font-bold text-neutral-900 mb-4">
        {{t("access_denied")}}
      </h1>

      <p class="text-lg text-neutral-900 mb-8">
        Sorry mate, you don't have permission to view this page. If you reckon this is a mistake, have a chat with your administrator.
      </p>

      <ButtonPrimary @click="goBack">
        <svg
          class="w-5 h-5 mr-2"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 19l-7-7m0 0l7-7m-7 7h18"
          />
        </svg>
        Go Back
      </ButtonPrimary>
    </div>
  </div>
</template>
