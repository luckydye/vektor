// Ref-counted body scroll lock shared by overlays (dialogs, mobile sidebar).
//
// Multiple surfaces can request a lock at once; the body stays locked until the
// last owner releases. This avoids one overlay's cleanup (e.g. a closing dialog)
// re-enabling background scroll while another (e.g. the mobile sidebar) is still
// open. Each caller must pair exactly one release() with its lock().

let count = 0;
let previousOverflow = "";

export function lockScroll(): void {
  if (typeof document === "undefined") return;
  if (count === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  count++;
}

export function unlockScroll(): void {
  if (typeof document === "undefined") return;
  if (count === 0) return;
  count--;
  if (count === 0) {
    document.body.style.overflow = previousOverflow;
  }
}
