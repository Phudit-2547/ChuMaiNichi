(() => {
  const lightColor = "#f4f4f7";
  const darkColor = "#0d1117";
  let mode = "auto";

  try {
    const stored = JSON.parse(localStorage.getItem("settings-state") || "{}");
    const value = stored && stored.state && stored.state.themeMode;
    if (value === "auto" || value === "light" || value === "dark") {
      mode = value;
    }
  } catch {
    /* use default */
  }

  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const isDark = mode === "dark" || (mode === "auto" && prefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.dataset.theme = isDark ? "dark" : "light";
  root.style.colorScheme = isDark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", isDark ? darkColor : lightColor);
})();
