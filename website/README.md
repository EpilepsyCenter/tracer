# TRACER website

Static site for [TRACER](https://github.com/EpilepsyCenter/tracer), built with
[Astro](https://astro.build) and deployed to
<https://epilepsycenter.github.io/tracer/> by
`.github/workflows/deploy-website.yml`.

## Pages

- `/` — homepage
- `/features` — the eleven analysis modules, expanded
- `/workflow` — the four-step tour from recording to figure
- `/docs` — the full user manual, rendered from `docs/MANUAL.md`

## Develop

```bash
cd website
npm install        # one-time
npm run dev        # http://localhost:4321/tracer
```

## Build

```bash
npm run build      # → website/dist/
npm run preview    # serve the built site
```

## Conventions

- **Design language.** `src/styles/global.css` is the shared token layer of the
  Epilepsy Center sites — the same block as the hub at
  <https://epilepsycenter.github.io/>. Paper `#f3f2ee` on ink `#15181f`, one
  interactive accent (`#007d93`), and `#0f1722` from TRACER's own scope mark as
  the identity colour. Change a palette or a typeface here and nowhere else.
- **Logos.** SVGs in `public/logo/` mirror the canonical files in
  `<repo-root>/logo/`. Update both if you rev the mark.
- **Manual and screenshots** are read straight out of `docs/`, so the site and
  the in-app manual can never drift apart. Adding a screenshot to
  `docs/screenshots/` is enough — the docs page picks it up.
- **Accuracy first.** This site describes real features only: no invented
  benchmarks, no placeholder lab logos, no fabricated quotes or numbers. The
  figures are real screenshots of the app.
- **Version string.** `v1.0.1` appears in the nav, the footer and the page
  headers — search and replace on release.
