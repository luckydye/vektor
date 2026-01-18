import { render, html } from "lit-html";

customElements.define(
  "document-statusbar",
  class StatusbarElement extends HTMLElement {
    
    connectedCallback() {
      window.addEventListener("document:edit", this.onEditorEvent);
      window.addEventListener("document:save", this.onEditorEvent);
    }
    
    disconnectedCallback() {
      window.removeEventListener("document:edit", this.onEditorEvent);
      window.removeEventListener("document:save", this.onEditorEvent);
    }
    
    onEditorEvent = (event: Event) => {
      if(event.type === "document:edit") {
        // TODO:
        // render(this.render(), this.shadowRoot);
      }
      if(event.type === "document:save") {
        
      }
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    render() {
      return html`
        <style>
            .container {
                pointer-events: auto;
            }
        </style>

        <div class="container">
            Test
        </div>
      `;
    }
  },
);
