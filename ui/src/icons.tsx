// Inline SVG icon set — paths copied verbatim from the mockup sprite
// (docs/desktop/mockups/app.html, <symbol id="i-...">). No external assets.
// [变更 2026-10 M3 刷新] full redraw, M3/Symbols-flavored rounded language:
// 24px grid · stroke 1.8 (set once on .svg.ic) · round caps/joins ·
// 0.5–1px optical inset · corner radii 2–2.6 on rects · meanings/names
// unchanged (+ the new `mark` brand symbol).
import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "deploy" | "skills" | "set" | "folder" | "check" | "checkc" | "x" | "xc"
  | "warn" | "info" | "ref" | "dl" | "up" | "trash" | "plus" | "edit" | "ext"
  | "term" | "search" | "copy" | "lock" | "shield" | "layers"
  | "chevd" | "chevr" | "clock" | "file" | "play" | "git" | "offline" | "arl"
  | "mark";

const PATHS: Record<IconName, ReactNode> = {
  deploy: (
    <>
      <path d="M21.3 2.7 10.9 13.1" />
      <path d="M21.3 2.7 14.6 21.2l-3.7-8.1L3 9.4l18.3-6.7z" />
    </>
  ),
  skills: (
    <>
      <path d="M20.5 16.2V7.8a1.9 1.9 0 0 0-.95-1.65l-6.6-3.81a1.9 1.9 0 0 0-1.9 0l-6.6 3.8A1.9 1.9 0 0 0 3.5 7.8v8.4a1.9 1.9 0 0 0 .95 1.65l6.6 3.81a1.9 1.9 0 0 0 1.9 0l6.6-3.81a1.9 1.9 0 0 0 .95-1.65z" />
      <polyline points="3.8 7.2 12 12 20.2 7.2" />
      <line x1="12" y1="21.5" x2="12" y2="12" />
    </>
  ),
  set: (
    <>
      <path d="M3.5 6.5h9.1m5.2 0h2.7M3.5 12h2.7m5.2 0h9.1M3.5 17.5h7.3m5.2 0h4.5" />
      <circle cx="15.2" cy="6.5" r="2.6" />
      <circle cx="8.8" cy="12" r="2.6" />
      <circle cx="13.4" cy="17.5" r="2.6" />
    </>
  ),
  folder: <path d="M21.5 17.8a2.3 2.3 0 0 1-2.3 2.3H4.8a2.3 2.3 0 0 1-2.3-2.3V6.3a2.3 2.3 0 0 1 2.3-2.3h4.1a2.3 2.3 0 0 1 1.63.68L11.9 6.1h7.3a2.3 2.3 0 0 1 2.3 2.3v9.4z" />,
  check: <polyline points="19.8 6.8 9.3 17.2 4.2 12.1" />,
  checkc: (
    <>
      <circle cx="12" cy="12" r="9.3" />
      <path d="m8.2 12.3 2.7 2.7 5-5.4" />
    </>
  ),
  x: <path d="M6.6 6.6l10.8 10.8M17.4 6.6 6.6 17.4" />,
  xc: (
    <>
      <circle cx="12" cy="12" r="9.3" />
      <path d="m9.3 9.3 5.4 5.4M14.7 9.3l-5.4 5.4" />
    </>
  ),
  warn: (
    <>
      <path d="M10.42 4.06a1.83 1.83 0 0 1 3.16 0l7.24 12.4a1.83 1.83 0 0 1-1.58 2.75H4.76a1.83 1.83 0 0 1-1.58-2.75l7.24-12.4z" />
      <line x1="12" y1="9.3" x2="12" y2="13.2" />
      <line x1="12" y1="16.7" x2="12.01" y2="16.7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.3" />
      <line x1="12" y1="16.2" x2="12" y2="11.8" />
      <line x1="12" y1="8.2" x2="12.01" y2="8.2" />
    </>
  ),
  ref: (
    <>
      <path d="M20.4 4.4v5.2h-5.2" />
      <path d="M3.6 19.6v-5.2h5.2" />
      <path d="M4.9 8.9a7.6 7.6 0 0 1 12.5-2.8l3 3.5" />
      <path d="M19.1 15.1a7.6 7.6 0 0 1-12.5 2.8l-3-3.5" />
    </>
  ),
  dl: (
    <>
      <path d="M20.7 14.8v3.4a2.3 2.3 0 0 1-2.3 2.3H5.6a2.3 2.3 0 0 1-2.3-2.3v-3.4" />
      <path d="m7.3 10.6 4.7 4.7 4.7-4.7" />
      <line x1="12" y1="15.3" x2="12" y2="3.6" />
    </>
  ),
  up: (
    <>
      <circle cx="12" cy="12" r="9.3" />
      <path d="M15.6 11.9 12 8.3l-3.6 3.6" />
      <line x1="12" y1="15.7" x2="12" y2="8.3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.2 6.4h15.6" />
      <path d="M9.8 6.2V4.9a1.9 1.9 0 0 1 1.9-1.9h.6a1.9 1.9 0 0 1 1.9 1.9v1.3" />
      <path d="M18.9 6.4v12.3a2.3 2.3 0 0 1-2.3 2.3H7.4a2.3 2.3 0 0 1-2.3-2.3V6.4" />
      <line x1="10.1" y1="10.6" x2="10.1" y2="16.6" />
      <line x1="13.9" y1="10.6" x2="13.9" y2="16.6" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5.2" x2="12" y2="18.8" />
      <line x1="5.2" y1="12" x2="18.8" y2="12" />
    </>
  ),
  edit: <path d="M14.7 4.6a2.3 2.3 0 0 1 3.25 0l1.45 1.45a2.3 2.3 0 0 1 0 3.25L8.5 20.2 3 21l.8-5.5L14.7 4.6z" />,
  ext: (
    <>
      <path d="M18.2 13.4v5.1a2.3 2.3 0 0 1-2.3 2.3H5.5a2.3 2.3 0 0 1-2.3-2.3V8.1a2.3 2.3 0 0 1 2.3-2.3h5.1" />
      <path d="m14.9 3.5h5.6v5.6" />
      <path d="M10.2 13.8 20.5 3.5" />
    </>
  ),
  term: (
    <>
      <path d="m5 16.6 4.9-4.9L5 6.8" />
      <line x1="12.4" y1="18.6" x2="19" y2="18.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11.2" cy="11.2" r="7.6" />
      <path d="m20.6 20.6-4.5-4.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.9" y="8.9" width="12.4" height="12.4" rx="2.5" />
      <path d="M5.4 14.9h-.7a2.3 2.3 0 0 1-2.3-2.3V5.4a2.3 2.3 0 0 1 2.3-2.3h7.2a2.3 2.3 0 0 1 2.3 2.3v.7" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="9.6" rx="2.6" />
      <path d="M7.9 11V7.6a4.1 4.1 0 0 1 8.2 0V11" />
    </>
  ),
  shield: <path d="M12 21.6c4.3-1.7 7.5-4.9 7.5-9.5V5.3L12 2.4 4.5 5.3v6.8c0 4.6 3.2 7.8 7.5 9.5z" />,
  layers: (
    <>
      <path d="m12 2.9 9.1 4.4L12 11.7 2.9 7.3 12 2.9z" />
      <path d="m2.9 12.1 9.1 4.4 9.1-4.4" />
      <path d="m2.9 16.7 9.1 4.4 9.1-4.4" />
    </>
  ),
  chevd: <path d="m6.6 9.4 5.4 5.4 5.4-5.4" />,
  chevr: <path d="m9.4 6.6 5.4 5.4-5.4 5.4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9.3" />
      <path d="M12 7.1V12l3.2 1.9" />
    </>
  ),
  file: (
    <>
      <path d="M14.2 2.8H6.6a2.4 2.4 0 0 0-2.4 2.4v13.6a2.4 2.4 0 0 0 2.4 2.4h10.8a2.4 2.4 0 0 0 2.4-2.4V8.4z" />
      <path d="M14.2 2.8v5.6h5.6" />
    </>
  ),
  play: <path d="M8 5.4v13.2a.6.6 0 0 0 .92.5l10.4-6.6a.6.6 0 0 0 0-1L8.92 4.9a.6.6 0 0 0-.92.5z" />,
  git: (
    <>
      <line x1="6.2" y1="3.4" x2="6.2" y2="14.6" />
      <circle cx="17.8" cy="6.2" r="2.8" />
      <circle cx="6.2" cy="17.8" r="2.8" />
      <path d="M17.8 9a8.8 8.8 0 0 1-8.8 8.8" />
    </>
  ),
  offline: (
    <>
      <line x1="2.3" y1="2.3" x2="21.7" y2="21.7" />
      <path d="M16.7 11.2a10.4 10.4 0 0 1 2.1 1.4M5.2 12.6a10.4 10.4 0 0 1 4.9-2.3M10.8 5.1a15.5 15.5 0 0 1 11.5 3.7M1.7 8.8a15.5 15.5 0 0 1 4.5-2.8M8.6 16.1a5.8 5.8 0 0 1 6.7 0" />
      <line x1="12" y1="19.8" x2="12.01" y2="19.8" />
    </>
  ),
  arl: (
    <>
      <line x1="19.3" y1="12" x2="5.3" y2="12" />
      <path d="m11.4 5.9-6.1 6.1 6.1 6.1" />
    </>
  ),
  // Brand mark: hub-and-spoke orchestration — a center node wired to three
  // specialist nodes (the agent-workbench identity; replaces the terminal
  // glyph in the brand/about tiles).
  mark: (
    <>
      <circle cx="12" cy="13.2" r="2.4" />
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="5.1" cy="17.05" r="1.7" />
      <circle cx="18.9" cy="17.05" r="1.7" />
      <path d="M12 10.1V7.4M9.3 14.7 7.2 15.9M14.7 14.7l2.1 1.2" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}

/** Renders `<svg class="ic …">` with the sprite's paths inlined. */
export function Icon({ name, className, style }: IconProps) {
  const cls = className ? `ic ${className}` : "ic";
  return (
    <svg className={cls} style={style} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
