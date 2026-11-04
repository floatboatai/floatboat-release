; ABOUTME: 为已安装的旧卸载器提供短且私有的临时目录，避免其文件迁移超过 Windows 路径限制。
!ifndef FLOATBOAT_INSTALLER_UPGRADE_TEMP_INCLUDED
!define FLOATBOAT_INSTALLER_UPGRADE_TEMP_INCLUDED
!ifndef BUILD_UNINSTALLER
; 由 customHeader 引入，确保 electron-builder 已定义安装/卸载注册表标识。
!include "LogicLib.nsh"
!if ${NSIS_PTR_SIZE} != 4
  !error "Floatboat upgrade temporary folder currently requires the 32-bit NSIS installer target."
!endif

Var FloatboatUpgradeTempPath
Var FloatboatUpgradeTempActive
Var FloatboatUpgradeOriginalTmp
Var FloatboatUpgradeOriginalTemp
Var FloatboatUpgradeTmpPresent
Var FloatboatUpgradeTempPresent
Var FloatboatUpgradeTempError

LangString FLOATBOAT_UPGRADE_TEMP_FAILED 1033 "Setup could not prepare a safe temporary folder for upgrading ${PRODUCT_NAME}. The old application has not been uninstalled. Windows error: $FloatboatUpgradeTempError."
LangString FLOATBOAT_UPGRADE_TEMP_FAILED 2052 "安装器无法准备安全的升级临时目录，尚未卸载旧版 ${PRODUCT_NAME}。Windows 错误：$FloatboatUpgradeTempError。"
LangString FLOATBOAT_UPGRADE_ENV_RESTORE_FAILED 1033 "Setup could not restore its temporary-folder settings. Close this installer and try again. Windows error: $FloatboatUpgradeTempError."
LangString FLOATBOAT_UPGRADE_ENV_RESTORE_FAILED 2052 "安装器无法恢复临时目录设置，请关闭安装器后重试。Windows 错误：$FloatboatUpgradeTempError。"

; 先查询所需长度：1 表示定义为空，0 且 ERROR_ENVVAR_NOT_FOUND 表示未定义。
; https://learn.microsoft.com/windows/win32/api/processenv/nf-processenv-getenvironmentvariablew
!macro FloatboatReadUpgradeEnvironment Name Value Present
  StrCpy ${Value} ""
  StrCpy ${Present} 0
  System::Call 'kernel32::GetEnvironmentVariableW(w "${Name}", p 0, i 0) i.r1 ?e'
  Pop $2
  ${If} $1 == 0
    ${If} $2 != 203
      StrCpy $FloatboatUpgradeTempError $2
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
  ${Else}
    ${If} $1 > ${NSIS_MAX_STRLEN}
      StrCpy $FloatboatUpgradeTempError 122
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
    StrCpy ${Present} 1
    ${If} $1 > 1
      System::Call 'kernel32::GetEnvironmentVariableW(w "${Name}", w .r0, i ${NSIS_MAX_STRLEN}) i.r1 ?e'
      Pop $2
      ${If} $1 == 0
        StrCpy $FloatboatUpgradeTempError $2
        Goto floatboat_upgrade_temp_failed
      ${EndIf}
      StrCpy ${Value} $0
    ${EndIf}
  ${EndIf}
!macroend

; 不让旧卸载器递归遍历自己的临时目录；已注册目录和本次目标都需排除。
!macro FloatboatCheckUpgradeTempOutside Directory
  ${If} "${Directory}" != ""
    ; NSIS 的同名指令要求末级目录存在；升级目标在首次迁移时可能尚未创建。
    System::Call 'kernel32::GetFullPathNameW(w "${Directory}", i ${NSIS_MAX_STRLEN}, w .r8, p 0) i.r0 ?e'
    Pop $2
    ${If} $0 == 0
      StrCpy $FloatboatUpgradeTempError $2
      Goto floatboat_upgrade_temp_failed
    ${ElseIf} $0 >= ${NSIS_MAX_STRLEN}
      StrCpy $FloatboatUpgradeTempError 206
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
    System::Call 'shlwapi::PathIsPrefixW(w r8, w r5) i.r0'
    ${If} $0 != 0
      StrCpy $FloatboatUpgradeTempError 87
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
  ${EndIf}
!macroend

; 从 customCheckAppRunning 的成功出口调用；只在已有旧卸载注册时切换环境。
Function FloatboatPrepareOldUninstallerTemp
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $3 0
  StrCpy $4 0
  StrCpy $FloatboatUpgradeTempError 0

  ${If} $FloatboatUpgradeTempActive == 1
    Goto floatboat_upgrade_temp_done
  ${EndIf}

  !ifndef INSTALL_MODE_PER_ALL_USERS
    Goto floatboat_upgrade_temp_done
  !endif

  ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $0 == ""
      ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${EndIf}
    ${If} $0 == ""
      ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${EndIf}
  !endif
  ${If} $0 == ""
    Goto floatboat_upgrade_temp_done
  ${EndIf}

  ; perMachine 安装器已在进程启动时提升，禁止在非提升进程中建立此目录。
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 == 0
    StrCpy $FloatboatUpgradeTempError 5
    Goto floatboat_upgrade_temp_failed
  ${EndIf}
  !insertmacro FloatboatReadUpgradeEnvironment "TMP" $FloatboatUpgradeOriginalTmp $FloatboatUpgradeTmpPresent
  !insertmacro FloatboatReadUpgradeEnvironment "TEMP" $FloatboatUpgradeOriginalTemp $FloatboatUpgradeTempPresent

  ; SECURITY_ATTRIBUTES 在当前 32 位 NSIS 中为 DWORD + 指针 + BOOL，共 12 字节。
  ; 保护 DACL 在 CreateDirectoryW 时生效，避免先创建再改 ACL 的竞争窗口。
  ; https://learn.microsoft.com/windows/win32/api/wtypesbase/ns-wtypesbase-security_attributes
  ; https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createdirectoryw
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", i 1, *p .r3, p 0) i.r0 ?e'
  Pop $2
  ${If} $0 == 0
    StrCpy $FloatboatUpgradeTempError $2
    Goto floatboat_upgrade_temp_failed
  ${EndIf}
  System::Call '*(i 12, p r3, i 0) p.r4'
  ${If} $4 == 0
    StrCpy $FloatboatUpgradeTempError 8
    Goto floatboat_upgrade_temp_failed
  ${EndIf}

  ReadRegStr $6 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $7 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCpy $9 0
  floatboat_upgrade_temp_create:
    IntOp $9 $9 + 1
    System::Call 'ole32::CoCreateGuid(g .r8) i.r0'
    ${If} $0 != 0
      StrCpy $FloatboatUpgradeTempError $0
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
    StrCpy $8 $8 8 1
    StrCpy $5 "$WINDIR\Temp\fb$8"
    ; 当前发行包的最长相对路径约 204 字符，给 ns*.tmp\old-install 保留 23 字符。
    StrLen $0 $5
    ${If} $0 > 30
      StrCpy $FloatboatUpgradeTempError 206
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
    !insertmacro FloatboatCheckUpgradeTempOutside "$INSTDIR"
    !insertmacro FloatboatCheckUpgradeTempOutside "$6"
    !insertmacro FloatboatCheckUpgradeTempOutside "$7"
    System::Call 'kernel32::CreateDirectoryW(w r5, p r4) i.r0 ?e'
    Pop $2
    ${If} $0 == 0
      ${If} $2 == 183
      ${AndIf} $9 < 8
        Goto floatboat_upgrade_temp_create
      ${EndIf}
      StrCpy $FloatboatUpgradeTempError $2
      Goto floatboat_upgrade_temp_failed
    ${EndIf}
    ; 只记录本次原子创建成功的目录，永不复用已有目录或链接。
    StrCpy $FloatboatUpgradeTempPath $5
    System::Free $4
    StrCpy $4 0
    System::Call 'kernel32::LocalFree(p r3)'
    StrCpy $3 0

  ; GetTempPath 优先读取 TMP；两者均设置，供旧卸载器新进程在初始化时继承。
  ; https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-gettemppathw
  StrCpy $FloatboatUpgradeTempActive 1
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$FloatboatUpgradeTempPath") i.r0 ?e'
  Pop $2
  ${If} $0 == 0
    StrCpy $FloatboatUpgradeTempError $2
    Goto floatboat_upgrade_temp_failed
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$FloatboatUpgradeTempPath") i.r0 ?e'
  Pop $2
  ${If} $0 == 0
    StrCpy $FloatboatUpgradeTempError $2
    Goto floatboat_upgrade_temp_failed
  ${EndIf}
  DetailPrint "Old uninstaller temporary folder: $FloatboatUpgradeTempPath"
  Goto floatboat_upgrade_temp_done

  floatboat_upgrade_temp_failed:
    ${If} $FloatboatUpgradeTempError == 0
      StrCpy $FloatboatUpgradeTempError 13
    ${EndIf}
    ${If} $4 != 0
      System::Free $4
    ${EndIf}
    ${If} $3 != 0
      System::Call 'kernel32::LocalFree(p r3)'
    ${EndIf}
    ; 此时尚未启动旧卸载器；恢复部分环境修改，并只尝试删除空目录。
    Push $FloatboatUpgradeTempError
    Call FloatboatRestoreOldUninstallerTemp
    Pop $FloatboatUpgradeTempError
    Goto floatboat_upgrade_temp_done

  floatboat_upgrade_temp_done:
    ClearErrors
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    ${If} $FloatboatUpgradeTempError != 0
      MessageBox MB_OK|MB_ICONSTOP "$(FLOATBOAT_UPGRADE_TEMP_FAILED)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
FunctionEnd

; 从 customInstall 开头调用，必须早于任何应用启动；失败退出时进程环境不会写回系统。
Function FloatboatRestoreOldUninstallerTemp
  Push $0
  Push $1
  StrCpy $FloatboatUpgradeTempError 0
  ${If} $FloatboatUpgradeTempActive == 1
    ${If} $FloatboatUpgradeTmpPresent == 1
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$FloatboatUpgradeOriginalTmp") i.r0 ?e'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", p 0) i.r0 ?e'
    ${EndIf}
    Pop $1
    ${If} $0 == 0
      StrCpy $FloatboatUpgradeTempError $1
    ${EndIf}
    ${If} $FloatboatUpgradeTempPresent == 1
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$FloatboatUpgradeOriginalTemp") i.r0 ?e'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", p 0) i.r0 ?e'
    ${EndIf}
    Pop $1
    ${If} $0 == 0
      StrCpy $FloatboatUpgradeTempError $1
    ${EndIf}
    ${If} $FloatboatUpgradeTempError != 0
      Goto floatboat_upgrade_temp_restore_done
    ${EndIf}
    StrCpy $FloatboatUpgradeTempActive 0
  ${EndIf}
  ${If} $FloatboatUpgradeTempPath != ""
    ; 旧卸载器可能自行清理备份；此处只删空外层目录，不承诺替它恢复文件。
    ClearErrors
    RMDir "$FloatboatUpgradeTempPath"
    ${If} ${Errors}
      DetailPrint "Keeping non-empty upgrade temporary folder: $FloatboatUpgradeTempPath"
    ${EndIf}
    StrCpy $FloatboatUpgradeTempPath ""
  ${EndIf}
  floatboat_upgrade_temp_restore_done:
  ClearErrors
  Pop $1
  Pop $0
  ${If} $FloatboatUpgradeTempError != 0
    MessageBox MB_OK|MB_ICONSTOP "$(FLOATBOAT_UPGRADE_ENV_RESTORE_FAILED)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd
!endif
!endif
