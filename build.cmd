@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Builds the VSIX package from a clean npm install (published specpress).
rem If you were using co-develop.cmd, run it again after building to restore
rem the local specpress link.
echo Preparing for packaging (clean install)...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json
call npm install --omit=optional
echo.
echo Running tests...
call npm test
if %errorlevel% neq 0 (
  echo Tests failed. Build aborted.
  exit /b 1
)
echo.
echo Building VSIX...
del /q *.vsix 2>nul
call npx @vscode/vsce package --no-rewrite-relative-links --allow-missing-repository
if %errorlevel% neq 0 (
  echo VSIX packaging failed. Build aborted.
  exit /b 1
)
echo.
echo Done.
