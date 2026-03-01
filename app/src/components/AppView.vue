<script setup>
defineProps({ html: { type: String, default: "" } });
</script>

<template>
  <iframe
    :srcdoc="html"
    sandbox="allow-scripts allow-forms allow-modals allow-popups"
    class="w-full border-none block"
    style="height: calc(100vh - 60px)"
  ></iframe>
</template>
