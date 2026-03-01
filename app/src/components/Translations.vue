<script setup lang="ts">
import strings from "../config/strings.json";

const props = defineProps<{
  lang: string;
}>();

function getLanguage() {
  if (typeof window !== "undefined") {
    const browserLang = navigator.language.split("-")[0];
    if (browserLang) {
      return browserLang;
    }
  } else {
    const ssrLng = props.lang;
    if (ssrLng) {
      return ssrLng;
    }
  }
  return "en";
}

globalThis._translations = strings;
</script>

<template>
</template>
