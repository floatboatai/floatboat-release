# Windows RC4 → RC5 安装诊断

此目录只用于临时分支 `codex/windows-installer-regression-rc5`。原生产工作流按字节保存在 `reference/release.production.yml`，临时分支的 `release.yml` 仅下载已签名包并在四个独立 Windows Server 2022 runner 上运行安装诊断，不编译源码、不写 Release/feed、不发送消息。

下载包之前先运行快速自检：在任务临时目录创建主 EXE 标记和普通文件，通过系统 Windows PowerShell 5.1 运行诊断脚本，确认已知文件锁产生错误 32，释放后错误归零。

安装目录固定为用户报告的 `C:\Program Files\Floatboat`。执行前要求目录与 Floatboat 卸载注册项均不存在；每个场景独占一次性 VM，避免注册表残留影响 `/D`。四个场景分别为：

- `baseline`：先用短 TEMP 完整首次安装 RC4，之后 RC4 同版覆盖、RC4 升 RC5、RC5 同版覆盖均使用 runner 的真实默认 TEMP（`[IO.Path]::GetTempPath()`）。任一步失败后立即用短 TEMP 重试同一步，记录对照结果；避免强制短 TEMP 掩盖默认路径限制。
- `long-temp`：RC4 首次安装后，使用长 TEMP 升级 RC5；记录存在旧卸载器暂存目的路径超过 260 字符的文件，再恢复短 TEMP 重试。
- `external-lock`：RC4 首次安装后，由系统目录内 PowerShell 对 `resources\app.asar` 建立只读且不共享删除的文件句柄；诊断脚本必须发现错误码 32，释放句柄后必须消失；分别记录有锁升级与释放后重试结果。
- `apostrophe-temp`：RC4 首次安装、RC4 同版覆盖、RC4 升 RC5、RC5 同版覆盖，始终使用含单引号和空格的 TEMP 路径。

每次安装命令使用 NSIS 官方要求的 `/S /D=<绝对路径>`（`/D` 最后且不加引号），上限 600 秒。进程只按本任务启动或捕获的后代 PID 及创建时间回收，不按进程名称全局查杀。下载后先验证 Authenticode；判断安装成功要求退出码为 0、主 EXE 和卸载器存在、ASAR 内 `package.json.version` 符合预期，同时保留 ProductVersion 和 FileVersion。

边界刻画不预设必须失败：有锁/长 TEMP 若成功也记录真实结果；超时、基础对照失败、报告未能发现已知锁、恢复后安装失败会令 job 失败。证据始终上传，包括 `results.json`、摘要、安装状态、子进程退出码、窗口文本、相关卸载注册项、最长文件路径和只读诊断报告。

已知签名包（均由 `floatboatai/floatboat-release` 的既有 Actions artifact 下载，2026-11-07 到期）：

| 包 | run | artifact | 源码 SHA |
| --- | --- | --- | --- |
| 0.6.3-rc.4 | 41804743562 | 13310782746 | a914f55076fee34aeb837a2fa80bb8c1f30cb25e |
| 0.6.3-rc.5 | 41812625426 | 13314232757 | 2e38ca4a54b5a8ec6c1d6279c99e74d4bc782777 |

诊断报告脚本来自源码任务的定稿版本，SHA256 为 `f4f2e0cc0fb276080f1a046b304f13ab2da5c79b5bd0ba03770a39c87b4cc6fe`。工作流未要求源码仓库依赖。

这些结果只证明隔离 VM 中的实际表现，不能替代用户 Windows 电脑上的现场验证；防病毒、权限、磁盘和历史注册状态可能不同。尚未触发工作流时不得宣称任何 Windows 场景已通过。

NSIS 参数真源：https://nsis.sourceforge.io/Docs/Chapter3.html#installerusagecommon
