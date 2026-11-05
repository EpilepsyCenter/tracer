# Contributing to TRACER

Thank you for your interest in TRACER. Bug reports, suggestions and code
are all welcome. By taking part you agree to follow the
[code of conduct](CODE_OF_CONDUCT.md).

## Reporting a bug or asking a question

- **From inside TRACER:** **Help ▸ Report a Bug…** sends a short form with
  the app version and system details attached.
- **On GitHub:** open an [issue](https://github.com/EpilepsyCenter/tracer/issues/new/choose).
  Please include the TRACER version (shown in the status bar), your
  operating system, what you did, what you expected and what happened.
  If a particular recording triggers the problem and you can share it,
  say so; a small example file makes most problems quick to fix.

Feature ideas are welcome as issues too. It helps to describe the
experiment and the measurement you need, not only the feature.

## Changing the code

TRACER is an Electron app with a React / TypeScript frontend
(`frontend/`) and a Python backend (`backend/`) that does all the
numerical work. The [README](README.md#developing) explains how to run it
from source; the [manual](docs/MANUAL.md) describes every feature.

1. Fork the repository and create a branch from `main`.
2. Make the change. Keep analysis code in `backend/analysis/` (plain
   functions that take arrays and parameters) and the API routes in
   `backend/api/`; the frontend only displays and edits.
3. Add or update a test in `tests/` when you change an analysis. Each test
   is a standalone script that prints `OK`; run them all with

   ```bash
   python tests/run_all.py
   npx tsc --noEmit -p . && npx tsc --noEmit -p tsconfig.node.json
   ```

4. Update `docs/MANUAL.md` when the change is visible to users.
5. Open a pull request describing what changed and why. The tests run
   automatically on every pull request.

Pull requests are reviewed by the maintainer, usually within two weeks.

## Licence

TRACER is released under the GNU General Public License, version 3 or
later. By contributing you agree that your contribution is released
under the same licence.
