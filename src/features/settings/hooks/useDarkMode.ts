import { useEffect } from "react";
import useSettingsStore from "../stores/settings-store";

export default function useDarkMode() {
  const { isDarkMode } = useSettingsStore();

  useEffect(() => {
    const html = document.documentElement;
    if (isDarkMode) {
      html.classList.add("dark");
    } else {
      html.classList.remove("dark");
    }
  }, [isDarkMode]);
}
