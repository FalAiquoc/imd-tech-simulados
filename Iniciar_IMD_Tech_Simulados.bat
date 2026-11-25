@echo off
title IMD Tech Simulados
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://127.0.0.1:8765
    python server.py --port 8765
) else (
    echo Python nao encontrado. Abrindo diretamente no navegador ^(modo IndexedDB local^)...
    start "" "imd_quest_plataforma_de_simulados_e_aprendizado_imd_ufrn_3.html"
)
