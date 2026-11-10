@echo off
setlocal
if not defined PASEO_ORCHESTRATOR_ROOT exit /b 1
if not defined PASEO_ORCHESTRATOR_DATA_ROOT exit /b 1
if not defined PASEO_ORCHESTRATOR_NODE exit /b 1
set "ELECTRON_RUN_AS_NODE=1"
set "PI_CODING_AGENT_DIR=%PASEO_ORCHESTRATOR_DATA_ROOT%\state\pi-profile"
"%PASEO_ORCHESTRATOR_NODE%" "%PASEO_ORCHESTRATOR_ROOT%\scripts\pi-supervisor.mjs" %*
exit /b %ERRORLEVEL%
