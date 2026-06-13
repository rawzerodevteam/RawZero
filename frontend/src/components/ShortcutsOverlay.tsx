import { SHORTCUTS } from "../shortcuts";
import { useStore } from "../store";

export function ShortcutsOverlay() {
  const setUI = useStore((s) => s.setUI);
  return (
    <div className="modal-backdrop" onClick={() => setUI({ showHelp: false })}>
      <div className="modal shortcuts-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>Raccourcis clavier</h2>
          <button className="mini-btn" onClick={() => setUI({ showHelp: false })}>✕</button>
        </header>
        <div className="shortcuts-grid">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="shortcut-row">
              <kbd>{keys}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
