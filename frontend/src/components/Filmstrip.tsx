import { useEffect, useRef } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { COLOR_HEX } from "../types";

export function Filmstrip() {
  const photos = useStore((s) => s.photos);
  const currentId = useStore((s) => s.currentId);
  const view = useStore((s) => s.view);
  const versions = useStore((s) => s.editsVersion);
  const openDevelop = useStore((s) => s.openDevelop);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-id="${currentId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [currentId, photos.length]);

  return (
    <div className="filmstrip" ref={ref}>
      {photos.map((p) => (
        <div
          key={p.id}
          data-id={p.id}
          className={"film-thumb" + (p.id === currentId ? " current" : "") + (p.flag === "reject" ? " rejected" : "")}
          style={p.color ? { borderColor: COLOR_HEX[p.color] } : undefined}
          onClick={() => (view === "develop" ? void openDevelop(p.id) : selectPhoto(p.id))}
          title={p.filename}
        >
          <img src={api.thumbUrl(p.id, versions[p.id] ?? 0)} alt={p.filename} loading="lazy" draggable={false} />
          {p.rating > 0 && <span className="film-rating">{"★".repeat(p.rating)}</span>}
          {p.flag === "pick" && <span className="film-flag">⚑</span>}
        </div>
      ))}
    </div>
  );
}
