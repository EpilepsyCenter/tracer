# PyInstaller spec for the TRACER backend.
#
# Produces a onedir bundle at `backend-dist/` with the executable named `main`.
# This layout is consumed by electron/main.ts: in production it spawns
# `<resources>/backend/main`, and package.json's `extraResources` maps
# `backend-dist/` -> `<resources>/backend/`.

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata
from pathlib import Path

PROJECT = Path(SPECPATH).resolve().parent
BACKEND = PROJECT / 'backend'

hidden = []
# uvicorn wires its loops/protocols lazily — PyInstaller can't see them.
hidden += collect_submodules('uvicorn')
# Our own packages are imported via `from api.files import router` etc.
# which means PyInstaller's import graph needs them explicitly, since
# SPECPATH lives outside backend/.
for pkg in ('api', 'analysis', 'readers', 'macros', 'utils', 'export'):
    hidden += collect_submodules(pkg)
# Neo and Myokit both load plugins/data files at import time.
hidden += collect_submodules('neo')
hidden += collect_submodules('myokit')
# Cohort Analysis (Phase B) deps. Several have lazy plugin loaders
# or runtime-discovered submodules PyInstaller's static analysis
# misses on its own. Listed explicitly so the bundled backend has
# everything pingouin / matplotlib / openpyxl / pzfx need at import
# time.
hidden += collect_submodules('pingouin')
hidden += collect_submodules('pandas')
hidden += collect_submodules('matplotlib')
hidden += collect_submodules('openpyxl')
hidden += collect_submodules('pzfx')
hidden += collect_submodules('scipy')
# NWB: pynwb / hdmf load their type maps and schema (YAML) at import.
hidden += collect_submodules('pynwb')
hidden += collect_submodules('hdmf')
hidden += collect_submodules('nwbinspector')

datas = []
datas += collect_data_files('neo')
datas += collect_data_files('myokit')
# matplotlib carries its own bundled fonts + style sheets; pingouin
# and pzfx ship CSV / XML templates the runtime reads from disk.
# Without these the imports succeed but the first call into the
# library fails with "no such file" deep inside the package.
datas += collect_data_files('matplotlib')
datas += collect_data_files('pingouin')
datas += collect_data_files('pzfx')
# pynwb's nwb-schema and hdmf's common schema are YAML files read at
# import; without them `import pynwb` fails in the bundled backend.
datas += collect_data_files('pynwb')
datas += collect_data_files('hdmf')
# nwbinspector's DANDI config (YAML) is read from the package folder.
datas += collect_data_files('nwbinspector')
# ...and it looks up its own version (importlib.metadata) when it runs.
datas += copy_metadata('nwbinspector')
datas += copy_metadata('pynwb')
datas += copy_metadata('hdmf')
# Bundled JetBrains Mono — used by cohort_graphs to render every
# matplotlib chart in the app's mono. ``backend/assets/fonts/`` is
# read by ``backend/utils/fonts.py`` via a path relative to its
# own __file__, so we ship the directory verbatim.
datas += [(str(BACKEND / 'assets' / 'fonts'), 'assets/fonts')]

# The base conda env includes deeplabcut/torch/PyQt/etc. — PyInstaller's
# module-graph pulls them in transitively through optional neo/scipy
# hooks. None are used by TRACER, so drop them aggressively.
# NOTE: ``pandas`` and ``matplotlib`` USED to live in this list back
# when the only entry points were trace-viewing. Phase B (Cohort
# Analysis) made both of them required at runtime — pingouin pulls
# in pandas, and we use matplotlib directly for graph rendering.
# Removing them here was the fix for the v0.4.0 build crash
# ("ModuleNotFoundError: No module named 'pandas'").
EXCLUDES = [
    'tkinter',
    'IPython', 'ipykernel', 'jupyter', 'jupyter_core', 'jupyter_client',
    'notebook', 'nbconvert', 'nbformat',
    'torch', 'torchvision', 'torchaudio',
    'tensorflow', 'keras', 'jax', 'jaxlib',
    'sklearn', 'sympy',
    'pyarrow',
    # PIL/Pillow USED to live here, but matplotlib.colors imports PIL
    # at module load (for image colormap support), so excluding it
    # crashes the bundled backend on import. Same shape of bug as the
    # earlier pandas/matplotlib exclusion fixed in v0.4.0.
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
    'wx', 'tk',
    'pytest', 'sphinx', 'docutils',
    'deeplabcut',
    # pkg_resources (setuptools) is only a Python < 3.8 fallback in
    # nwbinspector; bundling it adds PyInstaller's pkg_resources startup
    # hook, which crashes with setuptools >= 81 ("no attribute
    # NullProvider") — the macOS runner installs setuptools 84.
    'pkg_resources',
    'cv2',
]

a = Analysis(
    [str(BACKEND / 'main.py')],
    pathex=[str(BACKEND)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='backend-dist',
)
