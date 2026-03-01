import { html, render } from "lit-html";

interface AITextareaState {
  value: string;
  placeholder: string;
  promptValue: string;
  isGenerating: boolean;
  isAvailable: boolean;
  isFocused: boolean;
}

customElements.define(
  "ai-textarea",
  class extends HTMLElement {
    session: any = null;
    state: AITextareaState = {
      value: "",
      placeholder: "",
      promptValue: "",
      isGenerating: false,
      isAvailable: false,
      isFocused: false,
    };

    connectedCallback() {
      this.state.value = this.getAttribute("value") || "";
      this.state.placeholder = this.getAttribute("placeholder") || "";
      this.update();
      this.checkAvailability();
    }

    disconnectedCallback() {
      if (this.session) {
        this.session.destroy?.();
      }
    }

    static get observedAttributes() {
      return ["value", "placeholder"];
    }

    attributeChangedCallback(name: string, oldValue: string, newValue: string) {
      if (oldValue === newValue) return;

      if (name === "value") {
        this.state.value = newValue || "";
        this.update();
      }
      if (name === "placeholder") {
        this.state.placeholder = newValue || "";
        this.update();
      }
    }

    update() {
      const template = html`
        <div
          class="ai-textarea-container"
          style="position: relative; width: 100%; display: flex; flex-direction: column; gap: 0.5rem;"
        >
          <textarea
            .value=${this.state.value}
            placeholder=${this.state.placeholder}
            @input=${this.handleTextareaInput}
            @change=${this.handleTextareaChange}
            @focus=${this.handleTextareaFocus}
            @blur=${this.handleTextareaBlur}
            style="box-sizing: border-box; width: 100%; min-height: 200px; padding: 0.75rem; border: 1px solid ${this.state.isFocused ? "#3b82f6" : "#d1d5db"}; border-radius: 0.375rem; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Courier New', monospace; font-size: 0.875rem; line-height: 1.5; resize: vertical; outline: none; transition: border-color 0.2s; box-shadow: ${this.state.isFocused ? "0 0 0 3px rgba(59, 130, 246, 0.1)" : "none"};"
          ></textarea>

          <div
            class="ai-controls"
            style="display: flex; gap: 0.5rem; align-items: center;"
          >
            <input
              type="text"
              .value=${this.state.promptValue}
              placeholder="Enter AI prompt (e.g., 'Make this more concise')"
              ?disabled=${this.state.isGenerating}
              @input=${this.handlePromptInput}
              @keydown=${this.handlePromptKeydown}
              style="flex: 1; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem; outline: none; transition: border-color 0.2s;"
            />

            <button
              type="button"
              ?disabled=${!this.state.isAvailable || this.state.isGenerating}
              @click=${this.handleGenerate}
              style="padding: 0.5rem 1rem; background: ${this.state.isAvailable && !this.state.isGenerating ? "#3b82f6" : "#9ca3af"}; color: white; border: none; border-radius: 0.375rem; font-size: 0.875rem; cursor: ${this.state.isAvailable && !this.state.isGenerating ? "pointer" : "not-allowed"}; transition: bg-background 0.2s; white-space: nowrap;"
              title=${this.state.isAvailable ? "Generate content with AI" : "AI language model is not available in this browser"}
            >
              ${
                this.state.isGenerating
                  ? "⏳ Generating..."
                  : this.state.isAvailable
                    ? "✨ Generate"
                    : "❌ AI Unavailable"
              }
            </button>
          </div>
        </div>
      `;

      if (!this.shadowRoot) {
        this.attachShadow({ mode: "open" });
      }

      render(template, this.shadowRoot);
    }

    handleTextareaInput = (e: Event) => {
      const value = (e.target as HTMLTextAreaElement).value;
      this.state.value = value;
      this.setAttribute("value", value);
      this.dispatchEvent(new Event("input", { bubbles: true }));
    };

    handleTextareaChange = () => {
      this.dispatchEvent(new Event("change", { bubbles: true }));
    };

    handleTextareaFocus = () => {
      this.state.isFocused = true;
      this.update();
    };

    handleTextareaBlur = () => {
      this.state.isFocused = false;
      this.update();
    };

    handlePromptInput = (e: Event) => {
      this.state.promptValue = (e.target as HTMLInputElement).value;
      e.stopPropagation();
    };

    handlePromptKeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleGenerate();
      }
    };

    handleGenerate = async () => {
      if (this.state.isGenerating || !this.state.isAvailable) return;

      const prompt = this.state.promptValue.trim();
      if (!prompt) return;

      const currentContent = this.state.value;
      const fullPrompt = currentContent
        ? `Current content:\n${currentContent}\n\nInstruction: ${prompt}`
        : prompt;

      this.state.isGenerating = true;
      this.setAttribute("data-generating", "true");
      this.update();

      this.dispatchEvent(new CustomEvent("ai-start", { bubbles: true }));

      try {
        if (!this.session) {
          // @ts-expect-error
          this.session = await LanguageModel?.create({
            initialPrompts: [
              {
                role: "system",
                content: `You are a professional web developer that knows the in and outs of HTML and CSS. You create layouts using HTML and CSS.
                  1. Only respond with markup that belongs inside a body element.
                  2. Include the CSS in a style tag within the body.
                  3. Do not use markdown syntax, we want raw HTML.`,
              },
            ],
          });
        }

        if (!this.session) {
          throw new Error("AI session could not be created");
        }

        this.state.value = "";
        this.update();

        const stream = this.session.promptStreaming(fullPrompt);
        const textarea = this.querySelector("textarea");

        for await (const chunk of stream) {
          this.state.value += chunk;
          if (textarea) {
            textarea.value = this.state.value;
            textarea.scrollTop = textarea.scrollHeight;
          }
        }

        this.setAttribute("value", this.state.value);
        this.update();
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        this.dispatchEvent(new CustomEvent("ai-complete", { bubbles: true }));

        this.state.promptValue = "";
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "AI generation failed";
        this.dispatchEvent(
          new CustomEvent("ai-error", {
            bubbles: true,
            detail: { error: errorMessage },
          }),
        );

        if (currentContent) {
          this.state.value = currentContent;
        }
      } finally {
        this.state.isGenerating = false;
        this.removeAttribute("data-generating");
        this.update();
      }
    };

    async checkAvailability() {
      try {
        // @ts-expect-error
        const availability = await LanguageModel?.availability();

        if (availability !== "unavailable") {
          this.state.isAvailable = true;
        } else {
          this.state.isAvailable = false;
        }
      } catch {
        this.state.isAvailable = false;
      }
      this.update();
    }

    get value(): string {
      return this.state.value;
    }

    set value(val: string) {
      this.state.value = val;
      this.setAttribute("value", val);
      this.update();
    }

    focus() {
      this.querySelector("textarea")?.focus();
    }
  },
);
