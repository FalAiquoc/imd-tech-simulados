@echo off
cd /d "%~dp0"
echo Iniciando IMD Quest com banco de dados SQLite local (simulados.db)...
start "" "http://127.0.0.1:8765"
python server.py --port 8765
pause
