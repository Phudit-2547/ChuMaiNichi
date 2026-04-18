import { select } from "d3";

export function trimOverflow(container: HTMLElement, startYear: number) {
  const svg = container.querySelector("svg");
  if (!svg) return;

  const jan1Start = new Date(startYear, 0, 1);
  const minTs = jan1Start.getTime() - jan1Start.getDay() * 86400000;

  const jan1End = new Date(startYear + 1, 0, 1);
  const endDow = jan1End.getDay();
  const spilloverEnd = new Date(jan1End);
  spilloverEnd.setDate(jan1End.getDate() + (6 - endDow));
  const maxTs = spilloverEnd.getTime() + 86400000;

  const sel = select(container);
  const now = new Date();
  const todayTs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  sel.selectAll(".ch-domain").each(function () {
    const g = this as SVGGElement;
    const firstRect = g.querySelector("rect.ch-subdomain-bg");
    if (!firstRect) return;
    const datum = select(firstRect).datum() as { t?: number } | null;
    if (!datum?.t) return;
    if (datum.t < minTs || datum.t >= maxTs) {
      g.remove();
      return;
    }
    select(g)
      .selectAll("rect")
      .each(function () {
        const d = select(this).datum() as { t?: number } | null;
        if (!d?.t) return;
        if (d.t < minTs || d.t >= maxTs) {
          (this as Element).remove();
        } else if (d.t === todayTs) {
          select(this as Element).classed("heatmap-today", true);
        }
      });
  });

  // Collapse gap left by removed overflow months:
  // After trimming Dec (x=0), Jan stays at its original x (e.g. 76),
  // leaving dead space. Shift all remaining domains left to close it.
  const remaining = svg.querySelectorAll<SVGSVGElement>(".ch-domain");
  if (remaining.length > 0) {
    let minX = Infinity;
    remaining.forEach((d) => {
      const x = parseFloat(d.getAttribute("x") || "0");
      if (x < minX) minX = x;
    });
    const labelGap = 6;
    if (minX > labelGap) {
      remaining.forEach((d) => {
        const x = parseFloat(d.getAttribute("x") || "0");
        d.setAttribute("x", String(x - minX + labelGap));
      });
    }
  }

  // Resize SVG to fit remaining content
  const bbox = svg.getBBox();
  const newWidth = Math.ceil(bbox.width + 4);
  const newHeight = Math.ceil(bbox.height);
  svg.setAttribute("width", String(newWidth));
  svg.setAttribute("height", String(newHeight));
  svg.setAttribute(
    "viewBox",
    `${Math.floor(bbox.x)} ${Math.floor(bbox.y)} ${newWidth} ${newHeight}`,
  );
}
