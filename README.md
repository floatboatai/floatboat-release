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

两套包使用独立的 Actions artifact 名称。在 `upload_uos_store=false` 的正式完整发布中，普通 Linux 包进入 CDN 根路径，UOS 送审包进入 `/uos/` 路径并单独更新官网 UOS 下载地址。仅运行 Linux 平台的正式 release-profile 时，普通包保留为 Actions artifact，UOS 包沿用原有的构建成功条件发布。`uos_upload_location` 默认值不影响这条普通分发路径。

需要在发布前只验证四个 Linux 包时，使用 `is_rc=true`、`platforms=linux`、`linux_package=deb-and-uos`、`desktop_variant=floatboat` 和 `package_set=app`。该组合使用 release 构建配置，只生成 Actions artifacts，不创建 CDN 对象或更新官网安装包地址。

只需要 UOS 的 amd64、arm64 两个安装包时，将上述组合的 `linux_package` 改为 `uos-floatboat`，并保持 `upload_uos_store=false`。双包分别保存在 `uos-linux-x64`、`uos-linux-arm64` Actions artifacts 中，保留 7 天；不会上传统信商店、创建 GitHub Release 或更新自动更新通道。

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

## UOS 工作台审核包准备

统信商店的包上传、提交审核和状态回读由 **UOS 工作台** 执行。`release.yml` 负责构建或复用 amd64/arm64 双包、校验内容，以及准备工作台可下载的 CDN 制品；它不登录统信平台，不读取统信账号凭证，也不执行商店发布器。Actions 运行成功只表示审核下载已准备好，不表示已经送审。

为兼容现有调用，输入名 `upload_uos_store` 保留，默认仍为 `false`。设为 `true` 的含义是“准备工作台审核下载”。`uos_upload_location` 默认且唯一支持的执行位置是 `workbench`；旧调用显式传入 `actions` 并开启 `upload_uos_store` 会在构建前明确失败，避免旧客户端将成功结果误认为已经自动送审。`upload_uos_store=false` 的普通发布与仅出包任务不受默认 `workbench` 影响；稳定版官网 CDN 分发沿用原有条件。

准备审核下载时，使用 `desktop_variant=floatboat`、`linux_package=uos-floatboat`、`build_profile=release`、`package_set=app`、`skip_release_notes=true`，并提供不可变的源码 SHA。RC 使用 `platforms=linux`、`is_rc=true`；稳定版使用 `is_rc=false` 且平台包含 Linux。仅当 `com.floatboat.desktop` 的双架构包均成功构建或经来源校验恢复，并通过无凭证校验后，才发布审核下载。

`reuse_uos_run_id` 默认为空，正常流程构建双包。需要复用时，填入本仓 `main` 上已完成的 `release.yml` 运行 ID，并指定与来源相同的 `version`、`repo_ref`；复用还要求 `upload_uos_store=true` 和 `platforms=linux`。恢复任务核对来源运行、成功任务、唯一未过期制品、原清单、源码 SHA、包版本、架构、大小和摘要，再保存为当前运行的制品。当前清单使用真实的新运行身份，并在 `buildSource` 保留原来源；任何来源不一致都会在准备 CDN 下载前失败。

审核包、清单和下载索引发布到 `https://release.aoe.chat/uos/review/`，按版本、来源 SHA 与完整内容 SHA 寻址，不修改官网正式下载指针。已有对象只有摘要和大小相同时才能复用。CDN 完整下载回验后，输出 `uos-review-downloads-<UOS版本>-<run>-<attempt>` 制品。工作台核验并下载双包，用户在官方页面登录后，由工作台所在机器完成上传、提交和回读。

只重跑失败的审核下载准备任务时，沿用无凭证校验任务输出的清单 artifact ID、摘要及生成轮次。清单必须属于同一次 workflow run 和源码，生成轮次必须与上游输出一致且不晚于当前执行轮次。下载索引的 `github` 保留清单来源，`executionGithub` 记录本次实际执行。修改工作流后应发起新运行，旧运行的重跑仍使用原来的工作流提交。

UOS 包版本遵循四段规则：稳定来源 `X.Y.Z` 生成 `X.Y.Z.0`，RC 来源 `X.Y.Z-rc.N` 生成 `X.Y.Z.N`。仅需两个安装包、不准备审核下载时，使用前述 Linux 双通道打包章节的 UOS 仅出包参数。

## UOS 独立登录诊断

**UOS Authentication Check**（`uos-auth-check.yml`）是手动从 `main` 发起的独立诊断入口，仅验证开发者会话和 `com.floatboat.desktop` 的应用身份，不构建、下载、上传或提交安装包。它不由 `release.yml` 调用，也不代表工作台已经登录或已经送审。

该诊断使用 `uos-app-store-production` Environment：部署分支只允许 `main`，Environment Secrets 保存 `UOS_STORE_USERNAME` 与 `UOS_STORE_PASSWORD`，可按需配置 required reviewers。凭证不写入 workflow、仓库变量、安装包、日志或制品。临时浏览器会话在任务结束时清理；遇到 CAPTCHA、MFA、账号绑定或授权确认等人工交互时停止。失败只输出固定错误码与脱敏分类。

`.github/scripts/uos-store-publisher.cjs` 等既有上传脚本保留作兼容与协议测试，`release.yml` 不再执行这些脚本。独立登录诊断沿用固定版本的 `.github/scripts/uos-browser-runtime`，在注入凭证前安装依赖和 Chromium；离线浏览器回归通过 `UOS_BROWSER_OFFLINE_TEST=true` 运行 `uniontech-browser-authenticator.integration.test.cjs`，只使用假页面和假凭证，不访问真实统信账号。
