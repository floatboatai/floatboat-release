Unicode true
Name "Floatboat upgrade temporary folder fixture"
OutFile "${FIXTURE_OUT}"
RequestExecutionLevel admin
SilentInstall silent
!include "LogicLib.nsh"
!define PRODUCT_NAME "Floatboat Upgrade Temp Fixture"
!define INSTALL_MODE_PER_ALL_USERS
!define INSTALL_REGISTRY_KEY "${FIXTURE_INSTALL_KEY}"
!define UNINSTALL_REGISTRY_KEY "${FIXTURE_UNINSTALL_KEY}"

Var FixtureMode
Var FixtureOutput
Var FixtureChildScript
Var FixtureLog
!ifdef FIXTURE_INSTRUMENTED
Var FixtureTraceLog
!endif
Var FixtureCreatedPath
Var FixtureFailure

!macro FixtureTrace Phase
  FileWriteUTF16LE $FixtureTraceLog "phase=${Phase}; error=$FloatboatUpgradeTempError; path=$FloatboatUpgradeTempPath; active=$FloatboatUpgradeTempActive; r0=$0; r1=$1; r2=$2; r3=$3; r4=$4; r5=$5; r6=$6; r7=$7; r8=$8; r9=$9$\r$\n"
!macroend

!include "${FIXTURE_HELPER}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"

!macro FixtureSetRegisters
  StrCpy $0 "fixture-register-0"
  StrCpy $1 "fixture-register-1"
  StrCpy $2 "fixture-register-2"
  StrCpy $3 "fixture-register-3"
  StrCpy $4 "fixture-register-4"
  StrCpy $5 "fixture-register-5"
  StrCpy $6 "fixture-register-6"
  StrCpy $7 "fixture-register-7"
  StrCpy $8 "fixture-register-8"
  StrCpy $9 "fixture-register-9"
!macroend

!macro FixtureCheckRegister Register Expected
  ${If} "${Register}" != "${Expected}"
    StrCpy $FixtureFailure "register was changed: expected ${Expected}"
    Goto fixture_failed
  ${EndIf}
!macroend

!macro FixtureCheckRegisters
  !insertmacro FixtureCheckRegister "$0" "fixture-register-0"
  !insertmacro FixtureCheckRegister "$1" "fixture-register-1"
  !insertmacro FixtureCheckRegister "$2" "fixture-register-2"
  !insertmacro FixtureCheckRegister "$3" "fixture-register-3"
  !insertmacro FixtureCheckRegister "$4" "fixture-register-4"
  !insertmacro FixtureCheckRegister "$5" "fixture-register-5"
  !insertmacro FixtureCheckRegister "$6" "fixture-register-6"
  !insertmacro FixtureCheckRegister "$7" "fixture-register-7"
  !insertmacro FixtureCheckRegister "$8" "fixture-register-8"
  !insertmacro FixtureCheckRegister "$9" "fixture-register-9"
!macroend

!macro FixtureWriteEnvironment Name Prefix
  System::Call 'kernel32::GetEnvironmentVariableW(w "${Name}", p 0, i 0) i.R0'
  ${If} $R0 == 0
    FileWriteUTF16LE $FixtureLog "${Prefix}_defined=0$\r$\n"
    FileWriteUTF16LE $FixtureLog "${Prefix}=$\r$\n"
  ${Else}
    FileWriteUTF16LE $FixtureLog "${Prefix}_defined=1$\r$\n"
    ReadEnvStr $R0 "${Name}"
    FileWriteUTF16LE $FixtureLog "${Prefix}=$R0$\r$\n"
  ${EndIf}
!macroend

Section
  SetRegView 64
  StrCpy $INSTDIR "$PROGRAMFILES64\FloatboatUpgradeTempFixture"
  ReadEnvStr $FixtureMode "FLOATBOAT_TEMP_FIXTURE_MODE"
  ReadEnvStr $FixtureOutput "FLOATBOAT_TEMP_FIXTURE_OUTPUT"
  ReadEnvStr $FixtureChildScript "FLOATBOAT_TEMP_FIXTURE_CHILD_SCRIPT"
  FileOpen $FixtureLog "$FixtureOutput\result.txt" w
  ${If} ${Errors}
    SetErrorLevel 100
    Quit
  ${EndIf}
  !ifdef FIXTURE_INSTRUMENTED
    FileOpen $FixtureTraceLog "$FixtureOutput\trace.txt" w
    ${If} ${Errors}
      SetErrorLevel 102
      Quit
    ${EndIf}
  !endif
  FileWriteUTF16LE $FixtureLog "mode=$FixtureMode$\r$\n"
  !insertmacro FixtureWriteEnvironment "TMP" "original_tmp"
  !insertmacro FixtureWriteEnvironment "TEMP" "original_temp"
  !insertmacro FixtureSetRegisters
  Push "fixture-stack-prepare"
  Call FloatboatPrepareOldUninstallerTemp
  Pop $R9
  ${If} $R9 != "fixture-stack-prepare"
    StrCpy $FixtureFailure "prepare changed the NSIS stack"
    Goto fixture_failed
  ${EndIf}
  !insertmacro FixtureCheckRegisters
  StrCpy $FixtureCreatedPath $FloatboatUpgradeTempPath
  FileWriteUTF16LE $FixtureLog "created_path=$FixtureCreatedPath$\r$\n"

  ${If} $FixtureMode == "noop"
    ${If} $FloatboatUpgradeTempActive == 1
    ${OrIf} $FixtureCreatedPath != ""
      StrCpy $FixtureFailure "no registration must not prepare a folder or change the environment"
      Goto fixture_failed
    ${EndIf}
  ${Else}
    ${If} $FloatboatUpgradeTempActive != 1
    ${OrIf} $FixtureCreatedPath == ""
      StrCpy $FixtureFailure "registered old version must prepare a private folder"
      Goto fixture_failed
    ${EndIf}
    ReadEnvStr $R0 "TMP"
    ReadEnvStr $R1 "TEMP"
    ${If} $R0 != $FixtureCreatedPath
    ${OrIf} $R1 != $FixtureCreatedPath
      StrCpy $FixtureFailure "both environment variables must reference the private folder"
      Goto fixture_failed
    ${EndIf}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$FixtureChildScript"' $R0
    ${If} $R0 != 0
      StrCpy $FixtureFailure "child environment or ACL validation failed"
      Goto fixture_failed
    ${EndIf}
    ${If} $FixtureMode == "sentinel"
      FileOpen $R0 "$FixtureCreatedPath\sentinel.txt" w
      ${If} ${Errors}
        StrCpy $FixtureFailure "could not create preservation sentinel"
        Goto fixture_failed
      ${EndIf}
      FileWrite $R0 "keep"
      FileClose $R0
    ${EndIf}
  ${EndIf}

  !insertmacro FixtureSetRegisters
  Push "fixture-stack-restore"
  Call FloatboatRestoreOldUninstallerTemp
  Pop $R9
  ${If} $R9 != "fixture-stack-restore"
    StrCpy $FixtureFailure "restore changed the NSIS stack"
    Goto fixture_failed
  ${EndIf}
  !insertmacro FixtureCheckRegisters
  !insertmacro FixtureWriteEnvironment "TMP" "restored_tmp"
  !insertmacro FixtureWriteEnvironment "TEMP" "restored_temp"
  ${If} $FixtureMode == "sentinel"
    IfFileExists "$FixtureCreatedPath\sentinel.txt" +3 0
      StrCpy $FixtureFailure "non-empty directory was removed"
      Goto fixture_failed
  ${ElseIf} $FixtureCreatedPath != ""
    IfFileExists "$FixtureCreatedPath\*.*" 0 +3
      StrCpy $FixtureFailure "empty directory was not removed"
      Goto fixture_failed
  ${EndIf}
  FileWriteUTF16LE $FixtureLog "status=passed$\r$\n"
  FileClose $FixtureLog
  SetErrorLevel 0
  Quit

  fixture_failed:
    Call FloatboatRestoreOldUninstallerTemp
    FileWriteUTF16LE $FixtureLog "status=failed$\r$\nerror=$FixtureFailure$\r$\n"
    FileClose $FixtureLog
    SetErrorLevel 101
    Quit
SectionEnd
