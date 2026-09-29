---
name: Callside
description: A quiet graphite interface for following a conversation and reading a suggested reply.
colors:
  accent: '#b5e8cb'
  accent-hover: '#d0f4de'
  accent-ink: '#172920'
  graphite: '#151b1b'
  panel: '#1b2221'
  assistant-panel: '#1e2723'
  subtle: '#202927'
  separator: '#34403c'
  warm-white: '#edf0e9'
  muted-sage: '#a7b5ad'
  field: '#1c2520'
  field-border: '#526058'
  secondary: '#23322a'
  stop: '#302b24'
  stop-text: '#f2c8a4'
  notice: '#243b2c'
  notice-border: '#587762'
  notice-text: '#d6e9dc'
  error: '#3a2a24'
  error-text: '#f6c8b5'
typography:
  headline:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '29px'
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: '-1px'
  answer:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '24px'
    fontWeight: 450
    lineHeight: 1.55
    letterSpacing: '-0.4px'
  title:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '17px'
    fontWeight: 500
    letterSpacing: '-0.2px'
  transcript:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '13px'
    lineHeight: 1.85
  field:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '12px'
    lineHeight: 1.65
  button:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '13px'
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: 'DM Sans Variable, sans-serif'
    fontSize: '10px'
  measurement:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: '9px'
rounded:
  key: '4px'
  field: '6px'
  control: '7px'
  notice: '8px'
  workspace: '12px'
spacing:
  control-gap: '8px'
  related: '12px'
  compact: '16px'
  inset: '20px'
  section: '24px'
  pane: '25px'
  answer: '30px'
  wide-pane: '32px'
  desktop-edge: '40px'
  column-gap: '48px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '13px 19px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.accent}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '13px 19px'
  button-stop:
    backgroundColor: '{colors.stop}'
    textColor: '{colors.stop-text}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '13px 19px'
  field:
    backgroundColor: '{colors.field}'
    textColor: '{colors.warm-white}'
    typography: '{typography.field}'
    rounded: '{rounded.field}'
    padding: '11px 12px'
  navigation:
    textColor: '{colors.muted-sage}'
    rounded: '{rounded.field}'
    padding: '10px 12px'
  navigation-active:
    backgroundColor: '{colors.subtle}'
    textColor: '{colors.warm-white}'
  workspace:
    backgroundColor: '{colors.panel}'
    rounded: '{rounded.workspace}'
  session-notice:
    backgroundColor: '{colors.notice}'
    textColor: '{colors.warm-white}'
    rounded: '{rounded.notice}'
    padding: '14px 18px'
---

# Design System: Callside

## Overview

**Creative North Star: "The Quiet Broadcast Desk"**

Callside uses dark green graphite, warm white text, and pale mint controls. Its visual hierarchy supports glancing between a conversation and a short answer. Dense supporting information stays subordinate to the words the operator needs to read aloud.

The system is flat and restrained. Thin separators organize related controls; small tonal changes distinguish work areas. The interface uses one type family, consistent outline icons, and explicit text for operating states. Surface composition and workflow decisions live in [the surface brief](docs/surface.md).

**Key Characteristics:**

- Large, generously spaced answer text.
- Compact, separated transcript turns with speaker and time metadata.
- Pale mint for the main action, active capture, and keyboard focus.
- Visible capture state with an available stop action.
- English interface copy and self-hosted typography.

## Colors

The palette is green graphite with warm white foregrounds, muted sage supporting text, and pale mint emphasis. The frontmatter defines the exact source values.

### Primary

- **Pale Mint** (`accent`): primary action, active capture, switch state, and focus.
- **Light Mint** (`accent-hover`): hover on filled primary actions.
- **Deep Green Ink** (`accent-ink`): text and symbols on mint surfaces.

### Neutral

- **Graphite** (`graphite`): page field.
- **Desk Panel** (`panel`): the main working surface.
- **Answer Panel** (`assistant-panel`): a small green lift behind suggested replies.
- **Subtle Green** (`subtle`): current navigation and quiet hover states.
- **Separator** (`separator`): section and pane boundaries.
- **Warm White** (`warm-white`): primary text.
- **Muted Sage** (`muted-sage`): helper copy and secondary metadata.
- **Field Green** (`field`, `field-border`): editable fields.

### State colors

The secondary button uses a dark green fill and mint text. Warm amber identifies stopping. Green notices identify session status and confirmations; warm clay identifies errors. State messages also name the condition in text.

**The Visible State Rule.** Color supplements a state label and action; it never carries recording or error state alone.

## Typography

**Interface font:** DM Sans Variable, with a sans-serif fallback. The installed Fontsource package bundles the font locally. **Measurement font:** platform monospace for time values and keycaps. The empty answer state uses one Georgia opening quotation mark; this is not a second headline family.

The answer is the largest sustained reading text. Page headings orient the operator without becoming promotional display typography. Supporting labels are compact and sentence case.

### Hierarchy

- **Headline:** the frontmatter headline role; narrows to 25px below 1100px. At the compact breakpoint, conversation headings become 23px and settings headings 24px.
- **Answer:** the frontmatter answer role; increases to 28px at 1500px and narrows to 23px at 760px.
- **Section title:** the title role. Pane titles use 14px at weight 550, reducing to 13px on compact layouts.
- **Transcript:** the transcript role, increasing to 14px at 1500px. Preserve line breaks and wrap long words.
- **Fields and help:** fields use the field role. Help uses 11px with line-height 1.75; section descriptions use 12px with line-height 1.8 and a maximum measure of 65ch.
- **Metadata:** labels use the label role; measurement values use tabular numerals. Footer and shortcut notes use 9px.

**The Speaking Scale Rule.** Suggested replies remain visually larger than transcript text and supporting controls.

## Layout

The application shell is centered with a maximum width of 1800px. Desktop page edges are 40px, becoming 60px from 1500px, 25px below 1100px, and 20px below 760px. The header is 82px high, reducing to 70px on compact layouts.

Settings use a centered maximum width of 1200px, with two columns separated by 48px and rows separated by 38px. Below 1100px the gaps become 32px; below 760px settings become one column with 28px gaps. Form pairs remain two equal columns where used. Headings receive more space above their section than between the heading and its content.

Conversation panes use a single enclosing surface and internal dividers. Wide layouts place transcript and answer side by side; compact layouts stack transcript before answer. Each pane manages its own long content. The exact session dimensions and first-viewport strategy are recorded in the surface brief.

The [local microphone test](docs/local-test-surface.md) extends the graphite and mint system with a transcript and timing workspace, explicit capture controls, and a stacked layout at 760px.

## Elevation & Depth

Tonal layers and thin borders establish structure. Main panels, notices, buttons, and fields have no shadows. The export menu is the single floating surface, using an offset soft shadow (`0 8px 20px #0004`) with its own border.

**The Quiet Depth Rule.** Reserve floating elevation for content that overlays the workspace.

## Shapes

The workspace has the broadest rounded corners. Fields and navigation use smaller corners, while buttons sit between them. Notices and menus use the notice radius. Circular geometry is reserved for status points and switches. Keycaps have a fine outline and the smallest radius.

Functional icons come from Lucide with consistent outline strokes. The product mark uses signal arcs and a point. There are no illustrative or photographic regions in the shipped interface. Asset provenance and font and icon licenses are recorded in [the asset register](docs/assets/README.md).

## Components

### Buttons

Primary and answer actions use mint with deep green ink. Standard primary, secondary, and stop controls have a minimum height of 44px. The full-width answer control is 49px tall, with its action name centered between the symbol and keycap. Compact start and stop actions reduce to 40px.

Secondary actions use a green fill and thin border. Stop actions use warm amber text and border on a brown field. Quiet actions have no filled surface until hover. Disabled buttons reduce opacity to 0.4 and use a blocked cursor. Normal color transitions last 150ms.

### Fields

Fields use dark green fill, a one-pixel border, and warm white input text. Placeholder text uses muted sage. The typed-question field groups its input and submit arrow inside one border. Textareas resize vertically. Disabled audio fieldsets reduce opacity to 0.55 and have an adjacent explanation naming how to unlock them.

### Navigation and presets

Navigation uses quiet rounded buttons; current and hovered items gain a subtle surface and warm white text. At the compact breakpoint the settings icon is removed while its text remains. Prompt presets are outlined controls with a stronger mint border and green fill for selection.

### Conversation surfaces

Transcript entries separate speaker, timestamp, and spoken text. Final entries use the primary text; in-progress entries use muted text and a live label. The answer pane separates automatic assistance from the suggested reply and the persistent action group. Earlier suggestions use a disclosure control.

### Operating states

Capture uses an explicit label, status point, and elapsed time. Settings repeat the active state and stop action above configuration. During connection and completion, the banner names the current activity. Stop becomes available while listening. Demo labels identify synthetic content and absence of audio capture.

Automatic assistance uses a labeled switch and supporting sentence. The switch thumb moves over 180ms. Audio meters scale horizontally over 100ms. The streaming answer has a one-second stepped cursor; completion removes it. Reduced-motion preferences disable animation and transitions.

### Browser details

Keyboard focus uses a 2px mint outline with 4px offset. The custom switch puts that outline on its visible track. Selection uses mint and deep green ink; text carets use mint. Scrollbars are narrow with a muted green thumb. Time values use tabular numerals.

## Do's and Don'ts

### Do:

- **Do** keep reply text visually dominant and comfortably spaced.
- **Do** keep capture status and a stop action visible during an active session, including settings.
- **Do** explain disabled configuration beside the affected controls.
- **Do** pair state colors with plain English text.
- **Do** preserve visible keyboard focus and reduced-motion behavior.
- **Do** use the existing self-hosted font and consistent functional icons.

### Don't:

- **Don't** replace the graphite surfaces with decorative gradients, glass, or textures.
- **Don't** elevate ordinary panels with floating shadows.
- **Don't** use mint as a large decorative background unrelated to an action or status.
- **Don't** style ordinary prose in monospace.
- **Don't** turn demonstrated or synthetic content into unlabeled product claims.
