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

需要在发布前只验证四个 Linux 包时，使用 `is_rc=true`、`platforms=linux`、`linux_package=deb-and-uos`、`desktop_variant=floatboat` 和 `package_set=app`。该组合使用 release 构建配置，只生成 Actions artifacts，不创建 CDN 对象或更新官网安装包地址。

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

## UOS 商店自动送审

`release.yml` 的 `upload_uos_store` 默认是 `false`。只有 `com.floatboat.desktop` 的稳定或 RC UOS Floatboat 构建、同一运行内 amd64/arm64 两个包均成功并通过无凭证校验后，才会进入统信商店上传并自动提交审核；RC 送审使用 `platforms=linux`、`is_rc=true`，稳定版沿用包含 Linux 的正式构建。普通 Linux、Windows、macOS、DeepSeek 与默认发布流程不会读取统信凭证。该流程完全运行在 GitHub Actions 中，不依赖 Desktop Backend 或其他发布请求服务。

仓库管理员需要创建 GitHub Actions Environment `uos-app-store-production`：

- Environment deployment branch 只允许 `main`。
- Environment Secrets 只配置 `UOS_STORE_USERNAME` 与 `UOS_STORE_PASSWORD`，不要把明文写入 workflow、仓库变量、安装包、日志或制品。
- 可按需要为 Environment 配置 required reviewers，审批通过前 Job 无法读取 Secrets。

发布器在受保护 Actions Job 内启动临时 Chromium，填写统信官方密码登录页并点击一次登录，由官网脚本执行加密、会话及后续中转；只有浏览器最终到达固定商店回跳且 `state` 匹配，才提取一次性 `code/state`，交给固定 HTTPS 商店接口建立短期会话。不会再把密码接口返回的第一个 `redirect` 当作最终商店回跳。浏览器不导出 Cookie 或登录状态，临时目录仅位于 Linux 内存文件系统，退出时关闭并删除；密码、Cookie、Token 不进入日志、安装包或回执。遇到 CAPTCHA、MFA、账号绑定、撤销注销、授权确认或其他人工提示时停止，不自动点击这些页面。

Playwright 使用 `.github/scripts/uos-browser-runtime` 中固定版本及锁文件，依赖和 Chromium 在注入 Secret 前安装；浏览器子进程不继承 UOS 凭证，认证步骤关闭调试日志，不启用截图、trace、video、HAR、持久 profile 或跨运行缓存。原有 API 模拟登录代码仅保留作协议测试，生产认证统一使用网页登录适配器。

`upload_uos_store=true` 登录成功后会继续上传双架构包并提交审核。首次真实运行前可按团队流程配置 Environment required reviewers，由发布负责人核对版本与无凭证校验 Job 后批准；本地 mock 测试证明协议形状、幂等状态机和脱敏边界，不替代真实账号资格与平台联调。

登录联调使用独立的 **UOS Authentication Check**（`uos-auth-check.yml`），手动从 `main` 发起。它使用与送审相同的网页登录适配器、受保护 Environment 与互斥组，只验证开发者会话和 `com.floatboat.desktop` 的应用身份，不构建、下载、上传或提交安装包。先通过真实认证检查，再发起完整送审；本地离线测试不代表真实账号已登录。失败只输出固定错误码、白名单静态原因和受限分类，不输出实际 URL、Cookie、令牌、页面内容、Playwright 原始异常或 code/state 值。

网页契约依据（2026-11-05）：[统信登录页面脚本](https://login.uniontech.com/main-es2015.c2432283df9f5420074a.js) 的 `toLogin`、`oauth2/follow` 与 `registerlogin`，以及[官方中文文案](https://login.uniontech.com/assets/i18n/zh.json)。固定 follow 页的“我已了解，立即登录”仅关闭社群宣传提示，允许点击一次；“授权并登录”等账号授权操作不自动确认。离线浏览器回归只使用假页面和假凭证，通过 `UOS_BROWSER_OFFLINE_TEST=true` 显式运行 `uniontech-browser-authenticator.integration.test.cjs`，不访问真实统信账号。

UOS 包版本遵循四段规则：稳定来源 `X.Y.Z` 生成 `X.Y.Z.0`，RC 来源 `X.Y.Z-rc.N` 生成 `X.Y.Z.N`。发布器会在上传前读取商店版本历史，拒绝低于商店最高版本的候选；同版本必须通过 amd64/arm64 SHA-256 内容一致性检查后才允许幂等恢复或提交审核。
