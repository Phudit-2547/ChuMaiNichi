import {
  DATA_REGION_LABELS,
  type DataRegion,
} from "../../../global/lib/regions";

const REGION_OPTIONS: ReadonlyArray<{
  value: DataRegion;
  label: string;
}> = [
  { value: "international", label: DATA_REGION_LABELS.international },
  { value: "japan", label: DATA_REGION_LABELS.japan },
];

export interface RegionSwitchProps {
  value: DataRegion;
  onChange: (region: DataRegion) => void;
  disabled?: boolean;
  className?: string;
}

export function RegionSwitch({
  value,
  onChange,
  disabled = false,
  className = "",
}: RegionSwitchProps) {
  return (
    <div className={`region-switch ${className}`.trim()}>
      <span className="region-switch__label">Server</span>
      <div
        className="region-switch__options"
        role="group"
        aria-label="Play data server"
        data-region={value}
      >
        {REGION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="region-switch__option"
            aria-pressed={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
