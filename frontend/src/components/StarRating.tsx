interface Props {
  value: number;
  onChange?: (v: number) => void;
  small?: boolean;
}

export function StarRating({ value, onChange, small }: Props) {
  return (
    <span className={"stars" + (small ? " stars-small" : "")}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={"star" + (n <= value ? " on" : "")}
          onClick={onChange ? (ev) => { ev.stopPropagation(); onChange(n === value ? 0 : n); } : undefined}
          role={onChange ? "button" : undefined}
        >
          ★
        </span>
      ))}
    </span>
  );
}
