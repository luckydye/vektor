<script lang="ts">
import { Comment, defineComponent, h, onMounted, ref } from "vue";

// biome-ignore lint/style/noDefaultExport: Vue SFC render-function component.
export default defineComponent({
  name: "ClientOnly",
  setup(_, { slots }) {
    const mounted = ref(false);

    onMounted(() => {
      mounted.value = true;
    });

    return () => (mounted.value ? slots.default?.() : h(Comment));
  },
});
</script>
