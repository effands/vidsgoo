# DESIGN.md — Google Vids Multi-Chrome Studio

## Identity & Soul
- **Product**: Google Vids Multi-Chrome Studio
- **Domain**: High-throughput multi-agent automated video generation console
- **Personality**: Professional workstation, tactile, high-density, dependable, engineering-grade
- **Visual Vibe**: Studio Workstation & Observability Console (combining clean linear tool aesthetics with real-time process monitoring)

---

## Palette System

### Dark Theme (Default)
- **Base Background**: `#0b0f17` (Deep Obsidian Slate)
- **Card / Surface**: `#131b26` (Solid Dark Slate, clean separation)
- **Sub-Surface / Inset**: `#0e1520` (Dark Charcoal for inputs and tables)
- **Border / Divider**: `#202c3d` (Crisp 1px borders, subtle hover `#33455e`)
- **Text Primary**: `#f1f5f9` (High-contrast Off-White)
- **Text Secondary / Muted**: `#94a3b8` (Clean readable Slate)
- **Accent Primary**: `#0284c7` (Precision Sky Blue)
- **Accent Active / Glow**: `#38bdf8`
- **Semantic Status**:
  - **Success / Online / Completed**: `#10b981` (Emerald)
  - **Processing / Active**: `#0ea5e9` (Sky Blue)
  - **Warning / Pending / Retry**: `#f59e0b` (Amber)
  - **Danger / Failed / Stop**: `#ef4444` (Rose / Crimson)

### Light Theme
- **Base Background**: `#f8fafc` (Clean Slate 50)
- **Card / Surface**: `#ffffff` (Pure White)
- **Sub-Surface / Inset**: `#f1f5f9` (Soft Slate)
- **Border / Divider**: `#cbd5e1` (Definite Slate 300)
- **Text Primary**: `#0f172a` (Deep Slate 900)
- **Text Secondary**: `#475569` (Slate 600)
- **Accent Primary**: `#0284c7`
- **Semantic Status**:
  - **Success**: `#059669`
  - **Processing**: `#0284c7`
  - **Warning**: `#d97706`
  - **Danger**: `#dc2626`

---

## Typography
- **UI Font**: `'Plus Jakarta Sans', system-ui, -apple-system, sans-serif`
  - Weight scale: 400 (regular), 500 (medium), 600 (semibold), 700 (bold), 800 (extrabold)
- **Data / Logs / Code Font**: `'JetBrains Mono', 'Fira Code', ui-monospace, monospace`
  - Used for timestamps, ports, status badges, log feeds, and prompt shortcuts.

---

## Anti-Slop Dials
- **ENERGY**: `3` (High utility, crisp contrast, punchy status indicators, clear density)
- **RHYTHM**: `3` (Structured 2-column workstation layout: Agent control column + Task & observability flow)
- **MOTION**: `2` (Snappy micro-interactions: 150ms-200ms cubic-bezier transitions, zero floaty delays)

---

## Purpose Directives
- **No generic nebula blur blobs**: Clean solid surfaces with crisp 1px borders.
- **No excessive glassmorphism blur**: High readability and instantaneous render performance.
- **No em dashes (`—`) in UI copy**: Clean punctuation (`,`, `.`, `:`, `·`).
- **Tactile feedback**: Clear `:hover`, `:active`, and `:focus-visible` outlines.
- **WCAG AA / AAA Contrast Compliance**: All text and icons maintain strict visibility standards.
