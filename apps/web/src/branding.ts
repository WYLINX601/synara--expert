const desktopProtocol = typeof window === "undefined" ? "" : window.location?.protocol;
const isLinxDesktop = desktopProtocol === "linx:" || desktopProtocol === "linx-preview:";
export const APP_BASE_NAME = isLinxDesktop ? "Linx" : "Synara";
export const APP_DISPLAY_NAME =
  desktopProtocol === "linx-preview:"
    ? "Linx Preview"
    : desktopProtocol === "synara-canary:"
      ? "Synara Canary"
      : desktopProtocol === "synara-beta:"
        ? "Synara Beta"
        : import.meta.env.DEV
          ? `${APP_BASE_NAME} (Dev)`
          : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
