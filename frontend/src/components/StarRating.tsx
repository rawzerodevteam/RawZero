import { useTranslation } from "react-i18next";

interface Props {
  value: number;
  onChange?: (v: number) => void;
  small?: boolean;
}

export function StarRating({ value, onChange, small }: Props) {
  const { t } = useTranslation();
  return (
    <span className={"stars" + (small ? " stars-small" : "")}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={"star" + (n <= value ? " on" : "")}
          onClick={onChange ? (ev) => { ev.stopPropagation(); onChange(n === value ? 0 : n); } : undefined}
          onKeyDown={onChange ? (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); onChange(n === value ? 0 : n); }
          } : undefined}
          role={onChange ? "button" : undefined}
          tabIndex={onChange ? 0 : undefined}
          aria-label={onChange ? t("library.starAria", { n }) : undefined}
          aria-pressed={onChange ? n <= value : undefined}
        >
          ★
        </span>
      ))}
    </span>
  );
}
