@echo off
REM Starts the local Firebase emulators (Auth, Firestore, Functions) for development.
REM Needs JDK 21+ for the Firestore emulator; picks the newest Temurin 21 if JAVA_HOME is
REM not already set. Rebuilds the functions first, since the emulator runs the compiled lib/.
setlocal
if not defined JAVA_HOME (
  for /d %%D in ("C:\Program Files\Eclipse Adoptium\jdk-21*") do set "JAVA_HOME=%%D"
)
if defined JAVA_HOME set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "%~dp0.."
call npm --prefix functions run build || exit /b 1
call firebase emulators:start --only auth,functions,firestore
