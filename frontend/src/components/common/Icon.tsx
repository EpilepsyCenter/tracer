import React from 'react'

/**
 * Minimal stroke-icon set — single 16x16 svg, 1.5px stroke,
 * uses currentColor so it inherits from the button text colour.
 *
 * Add a new icon by appending to ``ICONS``. Reach for a real icon
 * library (lucide-react, etc.) only when this set outgrows ~25
 * glyphs — the manual approach keeps the bundle slim and lets us
 * tune individual paths to the rest of the typography.
 */
export type IconName =
  | 'folder'
  | 'chevron-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'ruler'
  | 'layers'
  | 'sigma'
  | 'tag'
  | 'chart'
  | 'grid'
  | 'users'
  | 'download'
  | 'gear'
  | 'help'
  | 'book'
  | 'bug'
  | 'external'
  | 'zoom-in'

const PATHS: Record<IconName, React.ReactNode> = {
  folder: (
    <path d="M2 4.5C2 3.67 2.67 3 3.5 3h3.2c.4 0 .78.16 1.06.44L9 4.5h3.5c.83 0 1.5.67 1.5 1.5v6.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 14 2 13.33 2 12.5v-8z" />
  ),
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'arrow-left':  <path d="M10 4 6 8l4 4M6 8h6" />,
  'arrow-right': <path d="m6 4 4 4-4 4M10 8H4" />,
  ruler: (
    <>
      <path d="M2.5 11.5 11.5 2.5l2 2-9 9z" />
      <path d="M4 10l1 1M5.5 8.5l1.5 1.5M7.5 6.5l2 2M9.5 4.5 11 6" />
    </>
  ),
  layers: (
    <>
      <path d="M8 2 2 5l6 3 6-3-6-3z" />
      <path d="m2 8 6 3 6-3" />
      <path d="m2 11 6 3 6-3" />
    </>
  ),
  sigma: <path d="M12 3H4l4 5-4 5h8" />,
  tag: (
    <>
      <path d="M2 7V3h4l8 8-4 4-8-8z" />
      <circle cx="5" cy="5" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  chart: (
    <>
      <path d="M2 13h12" />
      <path d="M3 11l3-4 3 2 4-5" />
    </>
  ),
  grid: (
    <>
      <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <path d="M2.5 13c0-1.93 1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5" />
      <path d="M10 6.5a2 2 0 1 0 0-3M14 13a3 3 0 0 0-2-2.83" />
    </>
  ),
  download: (
    <>
      <path d="M8 2v8m0 0 3-3m-3 3-3-3" />
      <path d="M3 13h10" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2 3.4 12.6M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6c.2-1.1 1-1.7 2-1.7 1.3 0 1.9 1 1.9 1.7 0 1.7-2 1.5-2 3.3" />
      <circle cx="8" cy="11.6" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  book: (
    <>
      <path d="M2.5 3.5h4c1 0 1.5.5 1.5 1.5v8c0-1-.5-1.5-1.5-1.5h-4z" />
      <path d="M13.5 3.5h-4c-1 0-1.5.5-1.5 1.5v8c0-1 .5-1.5 1.5-1.5h4z" />
    </>
  ),
  // Stylised bug — round body, antennae, and three pairs of legs.
  bug: (
    <>
      <ellipse cx="8" cy="9" rx="3.5" ry="4.5" />
      <path d="M8 4.5V3.5" />
      <path d="M6.5 3.5 5.5 2.5M9.5 3.5l1-1" />
      <path d="M4.5 7H3M4.5 9H2.5M4.5 11H3" />
      <path d="M11.5 7H13M11.5 9H13.5M11.5 11H13" />
    </>
  ),
  'zoom-in': (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3 14 14M5 7h4M7 5v4" />
    </>
  ),
  external: (
    <>
      <path d="M9 2h5v5" />
      <path d="m14 2-7 7" />
      <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
    </>
  ),
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

export function Icon({ name, size = 14, className }: IconProps) {
  return (
    <span className={`icon ${className ?? ''}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {PATHS[name]}
      </svg>
    </span>
  )
}
