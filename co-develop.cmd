@echo off
cd /d "%~dp0"
echo Setting up local specpress link for co-development...
echo.
echo Prerequisites:
echo   - specpress repo cloned at ..\specpress (sibling of this repo)
echo   - npm install run in the specpress repo
echo.

rem Ensure all dependencies are installed (including specpress from npm)
call npm install

rem Replace the npm-installed specpress with a junction to the local repo
if exist node_modules\specpress rmdir /s /q node_modules\specpress
mklink /J node_modules\specpress "%~dp0..\specpress"

echo.
echo Verifying link...
findstr "fileResolver" node_modules\specpress\lib\md2docx\md2docx.js >nul 2>&1
if %errorlevel% equ 0 (
  echo OK: node_modules\specpress points to local repo.
) else (
  echo ERROR: Link verification failed.
  exit /b 1
)

echo.
echo Done. Press F5 to launch the Extension Development Host.
