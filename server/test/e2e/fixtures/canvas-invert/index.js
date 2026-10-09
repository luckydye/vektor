export function activate(ctx) {
  ctx.canvas.inspectors.register("invert", {
    types: ["image"],
    title: "Invert",
    render(container, handle) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", "Invert colours");
      const sync = () => {
        input.checked = handle.data()?.invert === true;
      };
      input.addEventListener("change", () => handle.update({ invert: input.checked }));
      container.append(input);
      sync();
      return handle.subscribe(sync);
    },
  });

  ctx.canvas.processors.register("invert", {
    types: ["image"],
    async process({ params, sourceUrl, signal }) {
      const response = await fetch(sourceUrl, { signal });
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      if (params?.invert) {
        context.globalCompositeOperation = "difference";
        context.fillStyle = "white";
        context.fillRect(0, 0, bitmap.width, bitmap.height);
      }
      return canvas.transferToImageBitmap();
    },
  });
}
