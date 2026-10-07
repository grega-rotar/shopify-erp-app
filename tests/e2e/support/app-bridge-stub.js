/* global document, window, HTMLElement, customElements */
/*
 * Served in place of https://cdn.shopify.com/shopifycloud/app-bridge.js in
 * e2e (tests/e2e/support/test.ts). Outside the admin there is no frame for
 * App Bridge to talk to, so this provides the parts the app uses and makes
 * them visible to the specs:
 *
 *  - `shopify.toast.show(message)` appends to #e2e-toasts;
 *  - `<ui-save-bar>` renders its buttons inline while shown, so a spec can
 *    press Save or Discard like a merchant would;
 *  - `shopify.resourcePicker` resolves to nothing (cancelled);
 *  - `<s-app-nav>` stays an inert element, as it is outside the admin.
 */
(function () {
  function toasts() {
    var box = document.getElementById("e2e-toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "e2e-toasts";
      box.setAttribute("role", "status");
      document.body.appendChild(box);
    }
    return box;
  }

  class UiSaveBar extends HTMLElement {
    connectedCallback() {
      if (!this.hasAttribute("open")) this.style.display = "none";
    }
    show() {
      this.setAttribute("open", "");
      this.style.display = "block";
      return Promise.resolve();
    }
    hide() {
      this.removeAttribute("open");
      this.style.display = "none";
      return Promise.resolve();
    }
    toggle() {
      return this.hasAttribute("open") ? this.hide() : this.show();
    }
    get showing() {
      return this.hasAttribute("open");
    }
  }
  if (!customElements.get("ui-save-bar")) {
    customElements.define("ui-save-bar", UiSaveBar);
  }

  function saveBar(id) {
    var element = document.getElementById(id);
    return element instanceof UiSaveBar ? element : null;
  }

  window.shopify = {
    config: { apiKey: "e2e-api-key", shop: "e2e", locale: "en" },
    idToken: function () {
      return Promise.resolve("e2e-id-token");
    },
    toast: {
      show: function (message) {
        var item = document.createElement("div");
        item.className = "e2e-toast";
        item.textContent = String(message);
        toasts().appendChild(item);
        return "e2e-toast";
      },
      hide: function () {},
    },
    saveBar: {
      show: function (id) {
        var bar = saveBar(id);
        return bar ? bar.show() : Promise.resolve();
      },
      hide: function (id) {
        var bar = saveBar(id);
        return bar ? bar.hide() : Promise.resolve();
      },
      toggle: function (id) {
        var bar = saveBar(id);
        return bar ? bar.toggle() : Promise.resolve();
      },
      leaveConfirmation: function () {
        return Promise.resolve();
      },
    },
    resourcePicker: function () {
      return Promise.resolve(undefined);
    },
    loading: function () {},
  };
})();
