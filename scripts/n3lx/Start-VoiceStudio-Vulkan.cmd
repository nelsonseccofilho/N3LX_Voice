@echo off
setlocal
cd /d "%~dp0..\.."
set "OMNIVOICE_TTS_BACKEND=voxcpm2"
set "OMNIVOICE_VOXCPM2_NATIVE_BIN=%CD%\..\llama.cpp-omni\build-vulkan\bin\Release\llama-tts-server.exe"
set "OMNIVOICE_VOXCPM2_NATIVE_BASE=%CD%\..\llama.cpp-omni\models\voxcpm2\VoxCPM2-BaseLM-Q8_0.gguf"
set "OMNIVOICE_VOXCPM2_NATIVE_ACOUSTIC=%CD%\..\llama.cpp-omni\models\voxcpm2\VoxCPM2-Acoustic-F16.gguf"
set "OMNIVOICE_SEED_VC_THREADS=6"
set "OMNIVOICE_SEED_VC_DEVICE=directml"
set "OMNIVOICE_SEED_VC_ROOT=%CD%\..\seed-vc"
set "OMNIVOICE_SEED_VC_PYTHON=%CD%\..\seed-vc\.venv-directml\Scripts\python.exe"
if not defined OMNIVOICE_DATA_DIR (
    if exist "%CD%\..\VoiceStudio\.local-data\omnivoice.db" (
        set "OMNIVOICE_DATA_DIR=%CD%\..\VoiceStudio\.local-data"
    ) else (
        set "OMNIVOICE_DATA_DIR=%CD%\.local-data"
    )
)
set "OMNIVOICE_PRELOAD_WATERMARK=0"
set "ELECTRON_RUN_AS_NODE="
set "VOICE_ELECTRON=%CD%\electron\node_modules\electron\dist\electron.exe"
if not exist "%VOICE_ELECTRON%" exit /b 1
start "" "%VOICE_ELECTRON%" "%CD%\electron"
endlocal