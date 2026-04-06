declare module "cal-heatmap" {
  export default class CalHeatmap {
    paint(options: unknown, plugins?: unknown[]): Promise<void>;
    destroy(): void;
  }
}

declare module "cal-heatmap/plugins/Tooltip" {
  const Tooltip: unknown;
  export default Tooltip;
}

declare module "cal-heatmap/plugins/CalendarLabel" {
  const CalendarLabel: unknown;
  export default CalendarLabel;
}
