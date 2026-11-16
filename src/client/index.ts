import { applySettings } from "./settings.js";
import type { ClientContext } from "./settings.js";
export interface ClientPlugin {
  inject: ["slots"];
  apply(ctx: ClientContext): void;
}
export interface ClientModule {
  id: "dsh-telegram-remote";
  factory(require: (name: "react") => typeof import("react")): ClientPlugin;
}
export interface ModuleLoader {
  load(module: ClientModule): void;
}
declare global {
  interface Window {
    __ModuleLoader__: ModuleLoader;
  }
}
window.__ModuleLoader__.load({
  id: "dsh-telegram-remote",
  factory(require) {
    const React = require("react");
    return {
      inject: ["slots"],
      apply(ctx) {
        applySettings(React, ctx);
      },
    };
  },
});
