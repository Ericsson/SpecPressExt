@echo off
cd /d "%~dp0"
echo Setting up local specpress link for co-development...
echo.
echo Prerequisites:
echo   - specpress repo cloned at ..\specpress (sibling of this repo)
echo   - npm install --ignore-scripts run in the specpress repo
echo.
cd /d "%~dp0..\specpress"
if %errorlevel% neq 0 (
  echo ERROR: specpress repo not found at ..\specpress
  exit /b 1
)
call npm link --ignore-scripts
cd /d "%~dp0"
call npm link specpress --ignore-scripts --save=false
echo.
echo Done. node_modules\specpress now points to your local specpress repo.
echo Run the extension host (F5) to use the local code.
