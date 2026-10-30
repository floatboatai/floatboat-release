# Floatboat Release

本仓库负责 Floatboat Desktop 的正式版、RC 与 Nightly 发布。

## 双变体六包发布

正常发布仍只需要提供一次 Desktop 源码 `repo_ref` 和一次 Floatboat 基础 `version`。流水线会从同一源码提交自动派生两个应用版本，并并行生成六个主安装包：

| 发行变体 | 应用版本 | macOS arm64 | macOS x64 | Windows x64 |
| --- | --- | --- | --- | --- |
| Floatboat | `X.Y.Z[-qualifier]` | DMG | DMG | EXE |
| Floatboat DeepSeek Agent | `X.Y.Z-deepseek[-qualifier]` | DMG | DMG | EXE |

每个 macOS 构建还会生成对应架构的 updater ZIP，因此完整应用制品集合为 6 个主安装包加 4 个 macOS ZIP。

- `release.yml` 默认仍通过 `desktop_variant=all` 构建双变体六包。
- 仅在 DeepSeek 正式版灰度或自动更新验收时，可使用 `desktop_variant=deepseek-agent`：流水线只构建三个 DeepSeek 主安装包和两个 macOS updater ZIP，使用独立 `deepseek-vX.Y.Z` tag，只发布 `deepseek-agent/` S3 前缀，不更新 Floatboat feed、制品或网站下载地址。
- DeepSeek-only 仅允许 `is_rc=false`、`build_profile=release`、`package_set=app` 和 macOS + Windows 完整平台组合，避免把部分制品误标成正式发布。
- `nightly.yml` 与 RC 发布只构建 Floatboat：macOS arm64、Windows x64 两个主安装包及 macOS arm64 updater ZIP；不构建 DeepSeek Agent、macOS x64 或 test launcher。
- 正式 stable 发布仍要求两个变体的 macOS arm64、macOS x64、Windows x64 全部成功；Nightly/RC 则要求 Floatboat macOS arm64 与 Windows x64 同时成功，缺少任一平台都不创建 Release 或写内部 feed。
- 正式版分别生成 Floatboat 与 DeepSeek Agent 自动更新元数据。DeepSeek RC 与 Nightly 只提供手动下载，不写入自动更新 feed。
- Floatboat 正式制品与 `latest*.yml` 上传到 S3 根路径；DeepSeek 正式制品与 `deepseek-agent*.yml` 上传到 `deepseek-agent/` 前缀。
- 正式版发布会先校验四份 updater 元数据中的版本、文件集合、大小和 SHA512，再上传并通过 S3 `head-object`
  核对对象；CloudFront 失效完成后还会从公网回读两个 feed 及 HEAD 全部十个更新制品，任一不一致都会阻止发布任务成功。

社区与产品信息见 [floatboat.ai](https://floatboat.ai)。问题可在本仓库提交，或联系 contact@floatboat.ai。

## Linux 双通道打包

当 `release.yml` 的 `platforms` 包含 `linux` 时，`linux_package` 默认使用 `deb-and-uos`，分别构建四个 Floatboat 安装包：

| 包类型 | amd64 | arm64 | 用途 |
| --- | --- | --- | --- |
| 普通 Linux DEB | `Floatboat-<version>-amd64.deb` | `Floatboat-<version>-arm64.deb` | 通用 Debian 系发行与手动下载 |
| UOS 送审 DEB | `Floatboat-<version>-amd64.deb` | `Floatboat-<version>-arm64.deb` | 统信应用商店送审，固定使用 `control.tar.gz` 与 `data.tar.gz` |

两套包使用独立的 Actions artifact 名称；正式完整发布时，普通 Linux 包进入 CDN 根路径，UOS 送审包进入 `/uos/` 路径并单独更新官网 UOS 下载地址。仅运行 Linux 平台的正式 release-profile 时，普通包保留为 Actions artifact，UOS 包在普通与 UOS 两组双架构构建都成功后发布。

Linux 仅构建 Floatboat，不构建 Floatboat DeepSeek Agent。未在 `platforms` 中选择 `linux` 时，现有 macOS 与 Windows 流程不受影响。

## macOS 签名后运行门禁

Release、RC 与 Nightly 在签名/公证检查之后、收集制品之前，使用源码仓库的
`scripts/packaging/packaged-workbench-runtime.mjs` 检查最终包内 Node 的 JIT 热循环、SQLite 读写备份，
并编译内置工作台模板。`node --version`、架构和签名校验不能替代实际脚本执行。
探针不修改签名包、不安装依赖；失败会阻止该平台上传制品。

此门禁依赖选定源码 ref 中的探针脚本：源码仓库修复应先合入，再启用本仓库步骤。
缺少探针的历史 ref 会明确失败，不静默跳过；重建旧版本时需先将签名修复和探针带入专用源码分支。

## 内部自动更新轨道

内部 Floatboat updater 使用独立前缀，不影响正式版 stable feed：

- `s3://aoe-desktop-releases/internal/nightly/`：Nightly 的 `latest-mac.yml`、`latest.yml` 及其引用的 Floatboat macOS/Windows 制品。
- `s3://aoe-desktop-releases/internal/rc/`：RC 的同类文件。
- `s3://aoe-desktop-releases/internal/channel.yml`：受控客户端策略，固定 schema 为 `schemaVersion: 1` 与 `preferredPrerelease: nightly|rc`。

两个内部轨道都只发布 Floatboat。Floatboat DeepSeek Agent 制品和元数据一律排除；测试、`internal-test`、launcher-only、缺少必要 macOS/Windows 构建的任务也不会写入内部 feed。macOS 架构集合以本次 `latest-mac.yml` 的完整声明为准，因此当前 Nightly 或 RC 只有 arm64 时可以发布，但 arm64 updater ZIP 与 Windows x64 EXE 是最低门槛。

每次 Nightly 或 RC 完整发布成功后，本次轨道会自动接管 `internal/channel.yml`，因此最后成功发布的预发布类型就是内部客户端当前检查的类型。切换只发生在本地 metadata 校验、immutable 制品上传与 S3 校验、no-cache metadata 上传、CloudFront 失效、公网 metadata 回读及所有制品 HEAD 校验全部成功之后；失败或部分发布不会改变当前首选轨道。stable 发布不修改内部策略。

内部发布采用失败关闭门禁：任何缺失制品、版本/文件集合/大小/SHA512 不匹配、DeepSeek 污染、S3 属性异常、CloudFront 后公网内容未收敛，都会令发布步骤失败；策略文件不会在轨道内容完成验证前上传。
