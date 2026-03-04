import { css, html, LitElement, type PropertyValues, unsafeCSS } from "lit";
import TAILWIND_CSS from "shadow-tailwind:css";
import { property, state } from "lit/decorators.js";
import { twMerge } from "tailwind-merge";
import { t } from "../libs/translations.js";
import { createRef, ref } from "lit/directives/ref.js";
import { mutateComments, type ResourceComment } from "../api/comments.js";
import { TOAST_TYPE, hashString } from "../libs/utils.js";
import { getTrackingMetadata, trackEvent } from "../libs/tracking.js";
import { commentDraftStorage } from "../libs/commentDraftStorage.js";

const MAX_IMAGE_SIZE = 1024;

function resizeImage(file: File, maxSize: number) {
  return new Promise<File>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Failed to load image"));
    }, 2000);

    const canvas = document.createElement("canvas");
    const src = URL.createObjectURL(file);

    if (!src.length) {
      throw new Error("Cant get src");
    }

    const img = new Image();
    img.src = src;

    img.onload = () => {
      // Calculate new dimensions based on maxSize for longest side
      const ratio = Math.min(maxSize / img.width, maxSize / img.height);
      const newWidth = img.width * ratio;
      const newHeight = img.height * ratio;

      canvas.width = newWidth;
      canvas.height = newHeight;

      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0, newWidth, newHeight);
      URL.revokeObjectURL(img.src);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to create blob"));
        } else {
          clearTimeout(timer);
          resolve(new File([blob], file.name));
        }
      });
    };

    img.onerror = (err) => {
      reject(new Error("Failed to load image"));
    };
  });
}

function createFileInput() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg, image/png, image/gif";
  input.multiple = true;
  return input;
}

function fileToCommentFile(file: File): CommentFile {
  return {
    url: URL.createObjectURL(file),
    filename: file.name,
    file: file,
  };
}

type CommentFile = { url: string; filename: string; file?: File };

export class FraCommentsInputElement extends LitElement {
  static styles = [
    unsafeCSS(TAILWIND_CSS),
    css`
      textarea {
        field-sizing: content;
      }
      /* Safari fix since textare cant grow with text */
      @supports (-webkit-hyphens:none) {
        textarea:not(:focus) {
          max-height: 4.8rem;
        }
      }
    `,
  ];

  @property({ type: String, attribute: "comment-id" })
  public commentId?: string | undefined;

  @property({ type: String, attribute: "reply-parent-comment-id" })
  public replyParentCommentId?: string;

  @property({ type: Object })
  public value?: ResourceComment;

  @property({ type: String, attribute: "draft-key" })
  public draftKey?: string;

  private fileInput = createFileInput();

  private files = new Set<CommentFile>();

  private saveDraftTimeout: ReturnType<typeof setTimeout> | null = null;

  private draftLoaded = false;

  private get storageKey(): string {
    if (this.draftKey) return this.draftKey;
    if (this.commentId) return `edit-${this.commentId}`;
    if (this.replyParentCommentId) return `reply-${this.replyParentCommentId}`;
    // Include URL hash in the fallback key to scope drafts to the current page
    const urlHash = hashString(window.location.href);
    return `new-comment-${urlHash}`;
  }

  constructor() {
    super();

    this.addEventListener("paste", this.onPaste);

    this.fileInput.addEventListener("change", () => {
      const files = this.fileInput.files;
      if (!files) throw new Error("No files found");

      this.handleFileList(files);
      this.fileInput.value = "";
    });
  }

  private textareaRef = createRef<HTMLTextAreaElement>();

  public focus() {
    this.textareaRef.value?.focus();
  }

  private async handleFileList(files: FileList) {
    const count = this.files.size + files.length;

    if (count > 3) {
      showToast({
        variant: "error",
        message: t("comments.input.upload_error_limit"),
      });
      return;
    }

    for (const file of files) {
      // resize new files
      resizeImage(file, MAX_IMAGE_SIZE)
        .then((resized) => {
          this.files.add(fileToCommentFile(resized));
          this.saveDraft();
          this.requestUpdate();
        })
        .catch((err) => {
          console.error("Failed to resize the image", err);
        });
    }

    this.requestUpdate();
  }

  private removeFile(file?: CommentFile) {
    if (!file) return;
    this.files.delete(file);
    this.saveDraft();
    this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();

    // init drag and drop listeners
    this.addEventListener("dragover", this.onDragOver);
    this.addEventListener("drop", this.onDrop);
    window.addEventListener("dragend", this.onDropCancel);
    window.addEventListener("dragleave", this.onDropCancel);
  }

  protected updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("value")) if (this.value) this.loadFromValue(this.value);
  }

  private async loadFromValue(data: ResourceComment) {
    const message = data.content?.toString();
    const files: Set<CommentFile> = new Set(data.images || []);

    const form = this.formRef.value;
    if (!form) throw new Error("No form found");

    form.reset();
    this.files.clear();

    for (const field of [...form]) {
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        const name = field.name;
        if (name === "files") {
          continue;
        }

        if (name === "message") {
          field.value = message || "";
        }
      }
    }

    this.files = files;
  }

  private async loadDraft() {
    // Only load draft once to avoid overwriting user input on refocus
    if (this.draftLoaded) return;

    try {
      const draft = await commentDraftStorage.getItem(this.storageKey);
      if (draft) {
        const form = this.formRef.value;
        if (!form) return;

        const messageField = form.querySelector<HTMLTextAreaElement>(
          'textarea[name="message"]',
        );
        if (messageField) {
          messageField.value = draft.message;
        }

        this.files.clear();
        for (const file of draft.files) {
          this.files.add(fileToCommentFile(file));
        }

        this.draftLoaded = true;
        this.requestUpdate();
      }
    } catch (error) {
      console.error("Failed to load draft:", error);
    }
  }

  private async saveDraft() {
    if (this.saveDraftTimeout) {
      clearTimeout(this.saveDraftTimeout);
    }

    this.saveDraftTimeout = setTimeout(async () => {
      const form = this.formRef.value;
      if (!form) return;

      const formData = new FormData(form);
      const message = formData.get("message")?.toString() || "";
      const files = [...this.files]
        .map((f) => f.file)
        .filter((f): f is File => f !== undefined);

      // Only save if there's content
      if (!message && files.length === 0) {
        await commentDraftStorage.removeItem(this.storageKey).catch(console.error);
        return;
      }

      try {
        await commentDraftStorage.setItem(this.storageKey, {
          message,
          files,
        });
      } catch (error) {
        console.error("Failed to save draft:", error);
      }
    }, 500);
  }

  private async clearDraft() {
    if (this.saveDraftTimeout) {
      clearTimeout(this.saveDraftTimeout);
      this.saveDraftTimeout = null;
    }
    this.draftLoaded = false;
    try {
      await commentDraftStorage.removeItem(this.storageKey);
    } catch (error) {
      console.error("Failed to clear draft:", error);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // remove drag and drop listeners
    this.removeEventListener("dragover", this.onDragOver);
    this.removeEventListener("drop", this.onDrop);
    window.removeEventListener("dragend", this.onDropCancel);
    window.removeEventListener("dragleave", this.onDropCancel);

    // Clear any pending draft save
    if (this.saveDraftTimeout) {
      clearTimeout(this.saveDraftTimeout);
      this.saveDraftTimeout = null;
    }
  }

  private onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (data?.files && data.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();

      this.handleFileList(data.files);
    }
  };

  private onDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    this.focused = true;
    this.dragging = true;
  };

  private onDropCancel = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    this.dragging = false;
  };

  private onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    this.dragging = false;

    if (event.dataTransfer) {
      const files = event.dataTransfer.files;
      this.handleFileList(files);
    }
  };

  @state() private dragging = false;

  @state() private error?: string;

  private async onSubmit(e?: SubmitEvent) {
    e?.preventDefault();
    e?.stopPropagation();

    this.error = undefined;

    const form = this.formRef.value;
    if (!form) throw new Error("No form found");

    const data = new FormData(form);
    const files = data.getAll("files");

    // resize images
    for (const file of files) {
      if (file instanceof File) {
        data.append("images", file);
      }
    }
    // we use 'images', so cleanup formdata
    data.delete("files");

    if (this.replyParentCommentId) {
      data.append("reply-parent-comment-id", this.replyParentCommentId);
    }

    if (this.commentId) {
      data.append("comment-id", this.commentId);
    }

    mutateComments(data)
      .then(async (response) => {
        if (response.error) {
          this.error = response.error;
          return;
        }

        this.requestUpdate();
        this.onFocusLost();

        showToast({
          variant: TOAST_TYPE.SUCCESS,
          message: t("comments.input.sendSuccess"),
        });

        this.dispatchEvent(
          new CustomEvent("comment:created", {
            bubbles: true,
            detail: response,
          }),
        );
      })
      .catch((error) => {
        console.error(error);

        showToast({
          variant: TOAST_TYPE.ERROR,
          message: t("general.error.loadingDataError"),
        });
      })
      .finally(() => {
        trackEvent(
          "interaction",
          "comment_new",
          {
            ...getTrackingMetadata(e),
            event_component: "comments",
          },
          e?.type,
        );
      });
  }

  // Loads state from a FormData object
  public loadFromFormData(data: FormData) {
    const form = this.formRef.value;
    if (!form) throw new Error("No form found");

    form.reset();
    this.files.clear();

    for (const field of [...form]) {
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        const name = field.name;
        if (name === "files") {
          continue;
        }

        const value = data.get(name);
        if (value) {
          field.value = value.toString();
        }
      }
    }

    const files = data.getAll("images");
    for (const file of files) {
      if (file instanceof File) {
        this.files.add(fileToCommentFile(file));
      }
    }
  }

  @state() private pickingFiles = false;

  @state() private focused = false;

  private async onFocusLost() {
    this.focused = false;

    // Clear the input and files
    const form = this.formRef.value;
    if (form) {
      form.reset();
    }
    this.files.clear();

    // Clear the draft when canceling
    this.clearDraft();

    this.requestUpdate();
    this.dispatchEvent(new CustomEvent("comment:blur"));
  }

  private formRef = createRef<HTMLFormElement>();

  // provide a FileList to set input files
  private get fileList() {
    const dataTransfer = new DataTransfer();
    [...this.files].map((file) =>
      dataTransfer.items.add(file.file || new File([], file.filename)),
    );
    return dataTransfer.files;
  }

  private openFilePicker() {
    this.pickingFiles = true;
    this.fileInput.click();
  }

  private onFocusIn = () => {
    // need to somehow know, when the filepicker was closed, just using focus here
    this.pickingFiles = false;
  };

  private onFocusOut = (e: Event) => {
    const form = e.currentTarget as HTMLFormElement;
    const value = new FormData(form).get("message");

    if (
      !form.matches(":focus-within") &&
      value === "" &&
      this.files.size === 0 &&
      !this.pickingFiles
    ) {
      this.onFocusLost();
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Enter":
        if (e.metaKey || e.ctrlKey) {
          // Submit on enter with ctrl/meta
          this.onSubmit();
        }
        break;
    }
  };

  render() {
    return html`
      <form
        ${ref(this.formRef)}
        class="group flex-1"
        @submit=${this.onSubmit}
        @focusin=${this.onFocusIn}
        @focusout=${this.onFocusOut}
        @keydown=${this.onKeyDown}
      >
        <div class="min-h-[70px] mq3:min-h-[84px] flex items-center">
          <div class="relative p-0 fra-input box-border focus-within:fra-input-active rounded-sm">
            <textarea
              ${ref(this.textareaRef)}
              @focus=${() => {
                this.focused = true;
                this.loadDraft();
              }}
              @input=${this.saveDraft}
              required
              name="message"
              class=${twMerge(
                "placeholder:style-text-disabled",
                "box-border block min-w-full max-w-full resize-none border-none bg-transparent p-element-m text-body focus:outline-none",
                "max-h-[50vh] overflow-y-auto",
              )}
              placeholder=${t("comments.input.placeholder")}
              aria-label=${t("comments.input.ariaLabel")}
            ></textarea>

            <input name="files" class="hidden" type="file" .files=${this.fileList} />

            <div class=${twMerge(
              "absolute right-element-m bottom-element-m z-1 mt-element-m flex gap-element-s",
              this.focused ? "" : "hidden",
            )}>
              <fra-icon-button variant="white" icon="add_image" @click=${() => this.openFilePicker()}></fra-icon-button>
            </div>

            <a-transition class=${twMerge("pointer-events-none overflow-hidden transition-all")}>
              <div>
                <div data-focused=${this.focused} class=${twMerge(
                  "z-1 flex flex-wrap gap-element-s p-element-m pt-0 pt-element-xs pr-element-6xl",
                  this.files.size > 0 || this.focused ? "" : "hidden",
                )}>
           	      ${[...this.files].map((file) => {
                    return html`
                      <div class="relative pointer-events-auto">
                		    <img src=${file.url} alt=${file.filename} height="40px" class="rounded-m block aspect-4/3 object-cover" />

                		    <button
                		      type="button"
                		      class=${twMerge(
                            "-top-2 -right-2 style-icon-default absolute rounded-full bg-white p-1 leading-none shadow-2xl",
                            "hover:style-fill-blue-hover hover:style-text-negative",
                            "after:-inset-2 after:absolute after:rounded-full after:bg-transparent after:content-['']",
                            this.focused ? "" : "hidden",
                          )}
                		      @click=${() => this.removeFile(file)}
                		    >
                 		    	<fra-icon name="close" size="12" class="text-[12px] block"></fra-icon>
                          <span class="sr-only">${t("comments.input.removeImageButton.hiddenLabel")}</span>
                		    </button>
                		  </div>
                		`;
                  })}
                </div>
              </div>
              ${this.focused ? html`<span></span>` : ""}
            </a-transition>
          </div>
        </div>

        <div class="flex justify-between gap-element-s">
          <div>
            ${this.error ? html`<fra-form-field-error>${this.error}</fra-form-field-error>` : ""}
          </div>

          <div class=${twMerge(
            "flex justify-end gap-element-s pt-element-xl transition-opacity duration-100",
            this.focused ? "" : "opacity-0",
          )}>
            <button class="fra-button-primary" type="submit">
              <span>${t("comments.input.send")}</span>
            </button>
            <button class="fra-button-secondary order-[-1]" type="button" @click=${() => {
              this.onFocusLost();
            }}>
              <span>${t("comments.input.cancel")}</span>
            </button>
          </div>
        </div>
      </form>

      ${
        this.dragging
          ? html`
            <a-portal>
              <div class=${twMerge(
                "lightbox-backdrop pointer-events-none fixed inset-0 z-10 h-full w-full items-center justify-center text-white",
                this.dragging ? "flex" : "hidden",
              )}>
                <fra-icon class="text-[120px]" name="add_image"></fra-icon>
              </div>
            </a-portal>
          `
          : ""
      }
    `;
  }
}

if (!customElements.get("fra-input-comment")) {
  customElements.define("fra-input-comment", FraCommentsInputElement);
}
