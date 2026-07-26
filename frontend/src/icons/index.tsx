/** Set d'icônes SVG unifié (monochrome, `currentColor`) — cf. audit UX §14.1 : remplace les
 * emoji/glyphes Unicode (rendu incohérent selon police/thème/OS, franges ClearType) par un
 * vecteur unique qui hérite la couleur du texte parent. Pattern repris de `SettingsView.tsx`
 * (`IconReset`/`IconClose`, désormais définis ici). Toutes les icônes partagent un viewBox
 * 16×16 et une prop `size` (px) pour ne plus coupler la taille au `font-size` du bouton. */

export interface IconProps {
  size?: number;
  className?: string;
}

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.4 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconAlbum({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="2.5" y="2.5" width="8" height="11" rx="1" />
      <path d="M8 5.2h4a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H6" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4.2 4.5 4.8 13a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.5" />
      <path d="M6.6 7v4M9.4 7v4" />
    </svg>
  );
}

export function IconImport({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 2v7.5" />
      <path d="M4.8 6.8 8 10l3.2-3.2" />
      <path d="M2.5 12.5h11" />
    </svg>
  );
}

export function IconExport({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 10V2.5" />
      <path d="M4.8 5.7 8 2.5l3.2 3.2" />
      <path d="M2.5 12.5h11" />
    </svg>
  );
}

export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 2.3v1.6M8 12.1v1.6M13.7 8h-1.6M3.9 8H2.3M11.9 4.1l-1.1 1.1M5.2 10.7l-1.1 1.1M11.9 11.9l-1.1-1.1M5.2 5.3 4.1 4.1" />
    </svg>
  );
}

export function IconExternal({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M6.5 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
      <path d="M9 2.5h4.5V7" />
      <path d="M13.3 2.7 7.3 8.7" />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 2.5v7.5" />
      <path d="M4.7 7.2 8 10.5l3.3-3.3" />
      <path d="M2.5 12.5h11" />
    </svg>
  );
}

export function IconGrid({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="2.3" y="2.3" width="4.8" height="4.8" rx="0.6" />
      <rect x="8.9" y="2.3" width="4.8" height="4.8" rx="0.6" />
      <rect x="2.3" y="8.9" width="4.8" height="4.8" rx="0.6" />
      <rect x="8.9" y="8.9" width="4.8" height="4.8" rx="0.6" />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base} strokeWidth={1.8}>
      <path d="M2.5 2.5l11 11M13.5 2.5l-11 11" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M2.8 8.2l3.4 3.4 7-7.2" />
    </svg>
  );
}

export function IconCopy({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

export function IconPaste({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="3.5" y="3" width="9" height="11" rx="1" />
      <path d="M6 3V2h4v1" />
      <path d="M6 8h4M6 10.5h4" />
    </svg>
  );
}

export function IconReset({ size = 13, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V6h-3.5" />
    </svg>
  );
}

export function IconUndo({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5V6h3.5" />
    </svg>
  );
}

export function IconRedo({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V6h-3.5" />
    </svg>
  );
}

export function IconRotateLeft({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M7 3.2A4.8 4.8 0 1 1 3.2 7" />
      <path d="M7 1v3.4H3.6" />
    </svg>
  );
}

export function IconRotateRight({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M9 3.2A4.8 4.8 0 1 0 12.8 7" />
      <path d="M9 1v3.4h3.4" />
    </svg>
  );
}

export function IconFlipH({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 1.5v13" strokeDasharray="1.6 1.6" />
      <path d="M4.5 5 2 8l2.5 3" />
      <path d="M11.5 5 14 8l-2.5 3" />
    </svg>
  );
}

export function IconFlipV({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M1.5 8h13" strokeDasharray="1.6 1.6" />
      <path d="M5 4.5 8 2l3 2.5" />
      <path d="M5 11.5 8 14l3-2.5" />
    </svg>
  );
}

export function IconMaskLinear({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M2 6h12" opacity={0.9} />
      <path d="M2 9h12" opacity={0.45} />
    </svg>
  );
}

export function IconMaskRadial({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <circle cx="8" cy="8" r="3.2" />
    </svg>
  );
}

export function IconLumRange({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

export function IconColorRange({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5A5.5 5.5 0 0 1 8 13.5z" fill="currentColor" stroke="none" opacity={0.5} />
    </svg>
  );
}

export function IconEdit({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3z" />
    </svg>
  );
}

export function IconChevron({ size = 10, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M5 3l6 5-6 5" />
    </svg>
  );
}

export function IconDiff({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 2 2.5 13h11z" />
      <path d="M8 6.5v3M8 11h.01" />
    </svg>
  );
}

export function IconGpu({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M9 1.5 3.5 9h3.3L6.5 14.5 12.5 7H9.2z" />
    </svg>
  );
}

export function IconClipHigh({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M2.5 10 8 3l5.5 7z" />
    </svg>
  );
}

export function IconClipLow({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M2.5 6 8 13l5.5-7z" />
    </svg>
  );
}

export function IconImage({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M2.8 12 6.5 8.3 8.7 10.5 11 8.2 13.2 10.4" />
    </svg>
  );
}

export function IconPalette({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} {...base}>
      <path d="M8 2a6 5.5 0 1 0 0 11c.9 0 1.5-.6 1.5-1.3 0-.4-.2-.7-.2-1.1 0-.6.5-1 1.1-1H11.5a2.5 2.5 0 0 0 2.5-2.6C14 3.9 11.3 2 8 2z" />
      <circle cx="5.3" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="7.3" cy="4.8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="10.2" cy="5.6" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}
