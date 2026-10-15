import { useLayoutEffect, useState } from "react";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
  type ThemeVariant,
} from "synara-ui/theme/theme.logic";
import { getAppTypographyScale } from "synara-ui/lib/appTypography";

export function useDemoAppearance() {
  const [theme, setTheme] = useState<ThemeVariant>("light");
  const [fontSize, setFontSize] = useState(13);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    const { variables } = buildThemeCssVariables(
      resolveThemePack(DEFAULT_THEME_STATE, theme),
      theme,
      { electron: false, systemUiFont: true },
    );
    for (const [name, value] of Object.entries(variables)) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    const scale = getAppTypographyScale(fontSize);
    const sizes = {
      base: scale.basePx,
      ui: scale.uiPx,
      "ui-lg": scale.uiLgPx,
      "ui-sm": scale.uiSmPx,
      "ui-xs": scale.uiXsPx,
      "ui-2xs": scale.ui2XsPx,
      "ui-meta": scale.uiMetaPx,
      "ui-timestamp": scale.uiTimestampPx,
      chat: scale.chatPx,
      "chat-code": scale.chatCodePx,
      "chat-meta": scale.chatMetaPx,
      "chat-tiny": scale.chatTinyPx,
      terminal: 12,
    };
    for (const [name, value] of Object.entries(sizes))
      root.style.setProperty(`--app-font-size-${name}`, `${value}px`);
    root.dataset.windowMaterial = "opaque";
  }, [theme, fontSize]);
  return {
    theme,
    fontSize,
    setFontSize,
    toggleTheme: () => setTheme((value) => (value === "light" ? "dark" : "light")),
  };
}
