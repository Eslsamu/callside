# Visual assets and attribution

## Callside assets

`callside-demo.png` is a screenshot of this repository's running local application, refreshed on October 2, 2026 in a hidden Electron window with the explicit synthetic demo and a completed demo answer. It contains no real call audio, customer transcript, API key, or account data. It demonstrates the UI; it does not establish real microphone, OS capture, or OpenAI performance.

`desktop/icon.svg` is an original geometric Callside application icon: a mint signal point and symmetric radio arcs on the application's graphite background. It was authored directly as SVG and rendered to the 1024 × 1024 `desktop/icon.png` in headless Chromium. `public/icon.svg` is the matching browser icon. These Callside assets are covered by this repository's MIT license.

## DM Sans

The application self-hosts **DM Sans** through `@fontsource-variable/dm-sans` (version 5.3.0 at the initial release). Font files are bundled with the application; opening the interface does not fetch fonts from Google Fonts.

Copyright 2014 The DM Sans Project Authors. The font is licensed under the **SIL Open Font License, Version 1.1**. The installed package's copyright notice and complete license are preserved in [DM Sans OFL](../../public/licenses/dm-sans-OFL.txt), which is also copied into production builds at `/licenses/dm-sans-OFL.txt`.

The font retains its own license. The repository's MIT license does not replace it.

## Lucide

Interface icons are supplied by `lucide-react` (version 0.468.0 at the initial release). The installed package declares the **ISC License** and notes that portions inherited from Feather are held by Cole Bemis, 2013–2022, under MIT; other Lucide portions are held by Lucide Contributors, 2022.

The package's exact copyright notice and license are preserved in [Lucide ISC](../../public/licenses/lucide-ISC.txt), which is also copied into production builds at `/licenses/lucide-ISC.txt`. The authored Callside application icon is separate from these interface icons.

Attribution was checked against the licenses shipped in the installed npm packages. When updating these dependencies, review their license files and refresh the bundled notices if they change.
