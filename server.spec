# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

import onnxruntime
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules


vieneu_datas = collect_data_files('vieneu') + collect_data_files('vieneu_utils')
vieneu_hiddenimports = collect_submodules('vieneu') + collect_submodules('vieneu_utils')
sea_g2p_datas = collect_data_files('sea_g2p')
sea_g2p_hiddenimports = collect_submodules('sea_g2p')
onnxruntime_binaries = collect_dynamic_libs('onnxruntime')
onnxruntime_binaries.append((
    str(Path(onnxruntime.__file__).parent / 'capi' / 'onnxruntime_pybind11_state.pyd'),
    'onnxruntime/capi',
))

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=onnxruntime_binaries,
    datas=vieneu_datas + sea_g2p_datas,
    hiddenimports=vieneu_hiddenimports + sea_g2p_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_pybind11_state.pyd'],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
