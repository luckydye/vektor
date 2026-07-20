export type ActionOptions = {
  title?: string;
  description?: string;
  icon?: () => string;
  group?: string;
  order?: number;
  run: () => Promise<void>;
};

interface PressedKeysMap {
  [key: string]: boolean;
}

const globalActions = new Map<string, ActionOptions>();
const globalShortcuts = new Map<string, Set<string>>();

const actionHistory: string[] = [];

const actionsEventTarget = new EventTarget();

// biome-ignore lint/complexity/noStaticOnlyClass: no
export class Actions {
  /**
   * Actions history
   * @returns {string[]} List of action ids. Most recent first.
   */
  static history() {
    // to calc how often a action is used to rank in command palette
    return actionHistory;
  }

  static rank(id: string, search: string): number {
    const action = Actions.get(id);
    if (action?.title?.toLocaleLowerCase().includes(search.toLocaleLowerCase())) {
      return 2;
    }
    if (action?.description?.toLocaleLowerCase().includes(search.toLocaleLowerCase())) {
      return 1;
    }
    return 0;
  }

  static entries() {
    return globalActions.entries();
  }

  static emit(event: string, options: CustomEventInit) {
    actionsEventTarget.dispatchEvent(new CustomEvent(event, options));
  }

  static subscribe(event: string, callback: (event: CustomEvent) => void) {
    actionsEventTarget.addEventListener(event, callback as EventListener);

    return () => {
      actionsEventTarget.removeEventListener(event, callback as EventListener);
    };
  }

  static register(id: string, options: ActionOptions) {
    globalActions.set(id.toLocaleLowerCase(), options);
    Actions.emit("actions:register", { detail: id });
    return id;
  }

  static unregister(idOrAction: string | ActionOptions) {
    if (typeof idOrAction === "string") {
      globalActions.delete(idOrAction);
      Actions.emit("actions:unregister", { detail: idOrAction });
    } else if (typeof idOrAction === "object") {
      for (const [id, action] of globalActions) {
        if (action === idOrAction) {
          globalActions.delete(id);
          Actions.emit("actions:unregister", { detail: id });
        }
      }
    }
  }

  static get(actionId: string) {
    return globalActions.get(actionId.toLocaleLowerCase());
  }

  static run(id: string) {
    const action = Actions.get(id);
    if (action) {
      action.run();
      actionHistory.unshift(id);
    } else {
      throw new Error(`Action with id '${id}', not found.`);
    }
  }

  static groups() {
    const groups = new Set<string>();
    for (const [, action] of globalActions) {
      if (action.group) groups.add(action.group);
      else groups.add("other");
    }
    return [...groups].sort((a, _b) => {
      if (a === "cities") {
        return -1;
      }
      return 0;
    });
  }

  static group(groupId: string) {
    const actions: [string, ActionOptions][] = [];
    for (const [id, action] of globalActions) {
      if ((action.group || "other") === groupId) actions.push([id, action]);
    }
    return actions.sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
  }

  /**
   * Adds a keybind to the keymap
   * @param {string} shortcut string of the shortcut
   * @param {string} actionId string of the action
   */
  static mapShortcut(shortcut: string, actionId: string) {
    const shortcuts = globalShortcuts.get(actionId);
    if (shortcuts) {
      shortcuts.add(shortcut);
    } else {
      globalShortcuts.set(actionId, new Set([shortcut]));
    }
  }

  /**
   * Removes a keybind from the keymap
   * @param {string} shortcut string of the shortcut
   * @param {string} actionId string of the action
   */
  static unmapShortcut(shortcut: string, actionId: string) {
    const shortcuts = globalShortcuts.get(actionId);
    if (shortcuts) {
      shortcuts.delete(shortcut);
      if (shortcuts.size === 0) {
        globalShortcuts.delete(actionId);
      }
    }
  }

  /**
   * Handle key event from key down and up event
   */
  static handleKey(event: KeyboardEvent, _keydown: boolean | undefined) {
    // The document editor's contenteditable lives inside a custom element's
    // shadow root, so document.activeElement resolves to the shadow host, not
    // the focused field. Descend through shadow roots to find the real one.
    let activeElement = document.activeElement as HTMLElement | null;
    while (activeElement?.shadowRoot?.activeElement) {
      activeElement = activeElement.shadowRoot.activeElement as HTMLElement;
    }
    const activeNodeName = activeElement?.nodeName;

    // cancel if inside a plain text field (title, search, ...)
    const ignoredElements = ["INPUT"];
    if (activeNodeName && ignoredElements.includes(activeNodeName)) {
      return;
    }

    // inside an editable region (the document editor is contenteditable,
    // not an <input>): let bare printable keys type normally and only allow
    // modifier combos (meta-b, ...) and control keys (Escape, ...) through.
    const isEditable = activeElement?.isContentEditable || activeNodeName === "TEXTAREA";
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
    if (isEditable && !hasModifier && event.key.length === 1) {
      return;
    }

    const actionId = Actions.getActionForShortcut(event);
    if (actionId) {
      const action = Actions.get(actionId);
      if (action) {
        Actions.run(actionId);
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  /**
   * Get shortcuts by action
   * @param {string} actionId Action ID
   */
  static getShortcutsForAction(actionId: string) {
    return globalShortcuts.get(actionId);
  }

  /**
   * Get action by event
   * @param {Event} event event
   */
  static getActionForShortcut(event: KeyboardEvent | PointerEvent) {
    const pressed: PressedKeysMap = {
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey,
    };

    if (event instanceof KeyboardEvent) {
      pressed[event.key.toLocaleLowerCase()] = true;
      pressed[event.code.toLocaleLowerCase()] = true;
    }

    let matchingActionId: string | undefined;

    for (const [actionId, shortcuts] of globalShortcuts) {
      shortcutsLoop: for (const shortcut of shortcuts) {
        const mappedShortcut: PressedKeysMap = {
          meta: false,
          ctrl: false,
          shift: false,
          alt: false,
        };

        const keys = shortcut.toLocaleLowerCase().split("-");
        for (const key of keys) {
          switch (key) {
            case "meta":
              mappedShortcut.meta = true;
              break;
            case "ctrl":
              mappedShortcut.ctrl = true;
              break;
            case "shift":
              mappedShortcut.shift = true;
              break;
            case "alt":
              mappedShortcut.alt = true;
              break;
            default:
              mappedShortcut[key] = true;
          }
        }

        // check if pressed matches with mapped shortcuut
        for (const key in mappedShortcut) {
          if (pressed[key] !== mappedShortcut[key]) continue shortcutsLoop;
        }

        if (Actions.get(actionId)) {
          matchingActionId = actionId;
        }
      }
    }

    return matchingActionId;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => Actions.handleKey(e, true));
  // window.addEventListener("keyup", (e) => Actions.handleKey(e, false));
}

// @ts-expect-error
globalThis.Actions = Actions;
