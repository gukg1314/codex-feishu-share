# codex分享飞书消息

macOS 独立软件：复制 Codex 已捕获的整条最终回复，自动打开分享窗口，搜索人员或群聊、单选后发送。只支持 Apple Silicon（M 系列芯片）。

## 用户打包

打包机先安装 **Node.js 22.12+、Go 1.23+**。双击本目录的 **一键打包.command**；首次联网下载锁定依赖和固定 CLI 源码。脚本不运行功能测试、不自动提交 Git。

每次成功打包在已有版本上加 1，只生成一个 ARM64 包，放在 `release/版本/`：

- `codex分享飞书消息-版本-mac-arm64.dmg`：Apple Silicon。

安装到“应用程序”的名称固定为 `codex分享飞书消息.app`，不带版本号；DMG 文件名和主界面的版本显示保留版本。

ARM64 DMG 检查通过后才发布目录并递增版本。失败保留旧版本，日志在 `release/package-时间.log`。若异常退出留下 `.package-lock`，先确认没有打包进程，再删除该锁目录重试。发行包未使用开发者证书、未公证，App 使用本地 ad-hoc 签名；首次打开按 macOS 安全设置允许。

**本次交付源码和入口，不代生成最终发行 DMG。**

## 首次配置

1. 在 M 系列芯片的 Mac 上将 App 拖到“应用程序”，打开设置。
2. 在飞书开放平台建立或选择应用，填自己的 App ID / App Secret，保存。密钥通过 stdin 交给私有 CLI，不进入普通设置或源码。
3. 应用开通并发布 `contact:user:search`、`im:chat:read`、`im:message.send_as_user`、`im:message`；按组织要求完成审批。
4. 点击“登录飞书”，本人扫描二维码或打开授权链接。App ID / Secret 不等于本人登录；完成 OAuth 后消息才由本人发送。
5. 安装 Codex Stop Hook，必要时选择自定义 Codex 配置目录；已有 Hook 会保留，写入前备份。按 Codex 的正常审阅流程信任 Hook，再重启或重新加载会话。
6. 让 Codex 完成一条新回复；设置收到真实 Stop 记录后才表示捕获生效。点击该回复的复制按钮，选择接收人，确认发送。

手动打开 App 会进入主界面，后台运行时再次双击 App 也可打开；关闭窗口仍后台监听，从右上角状态栏打开设置或退出。分享打开时隐藏已有设置窗口，点击“确认”立即隐藏分享窗口并在后台发送，成功或失败都不弹提示、不恢复设置。

主界面默认 1180×850，三个模块从左到右显示飞书应用配置、本人登录、Hook 监听。分享窗口保留原生标题栏，600px 白底内容铺满，无外层间距和内部关闭按钮。

飞书配置列下方有两个独立开关：

- **隐藏程序坞图标**：默认开启，仅隐藏程序坞图标，手动打开或再次双击 App 仍可显示主界面；关闭开关恢复普通 Dock 模式。选择会保存，关窗口继续后台运行，状态栏“退出”才结束。
- **登录电脑自动启动**：默认关闭，安装正式 App 后可开启。若显示“等待 macOS 允许”，点击“打开 macOS 登录项设置”批准；返回设置窗口会刷新实际状态。登录自启始终静默，即使没有配置也不弹窗口；关闭开关取消自启。

## 使用边界

- 只识别 Hook 已保存的完整最终回复；历史未捕获回复、代码块、部分复制不会命中。
- 只在 Codex 前台检查变化后的剪贴板。全文相同也可能触发，无法证明具体点击了哪个复制按钮。
- 匹配只处理 CRLF 和首尾空白；发送仅去掉首尾空白，内部 Markdown 原样保留。超过 24,000 个 Unicode 字符时拒绝单条发送。
- 飞书实际排版受其 Markdown 渲染器限制。发送失败、超限、缺少权限或结果未确认只写本地日志，不弹提示、不自动重发。后台发送期间不接新的分享，结束后再次复制可打开新分享。
- 窗口与正文预加载；命中后立即显示，不等待网络或 CLI。最终窗口 20 次 ≤500ms 及真实使用体验以交付检查记录为准。

## 独立 CLI 与隐私

内置 [lark-cli 1.0.72](https://github.com/larksuite/cli/tree/4a56748bfa941ff0ee0bfec92e65acac427732b0)，固定提交 `4a56748bfa941ff0ee0bfec92e65acac427732b0`，使用 `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64` 构建。压缩包 SHA-256：`c8d26dcbbdee1aedaa0d42c8055429b0275a8e70f1c69b891f568e7ff17c61d7`；补丁前逐个校验源文件和替换次数，构建记录在 `bin/build-manifest.json`。

`patches/lark-cli.json` 保存三个必要补丁：专用钥匙串 service `codex-feishu-share`；手工 `post --content` 不改写 @mention；退出只删除本软件本地 token，避免原版远端 revoke 影响同应用其他客户端。

业务始终使用 `codex-share` profile、私有配置目录及内置 CLI；不改本机 CLI 默认 profile。相同 App ID 的飞书后台权限仍属于同一个应用，后台撤销应用授权可能影响其他客户端。

数据固定在 `~/Library/Application Support/CodexFeishuShare/`，包含正文缓存 `captures/`、私有 CLI 配置 `lark-cli/`、Hook 启动器 `hook/`、`runtime.json` 和普通设置。诊断日志在 `~/Library/Logs/CodexFeishuShare/`，按大小轮转；不写正文、未匹配剪贴板、Secret、token 或 device code。

删除本地数据：先从设置退出飞书并退出 App，按需删除上述数据、日志目录。彻底清理应用密钥时，在“钥匙串访问”中仅删除 service 为 `codex-feishu-share` 的条目；不要删除 `lark-cli` 条目。需卸载 Hook 时，从 Codex `hooks.json` 中移除本工具那一项，保留其他定义。

## 升级和图标

本次更换了 bundle ID，macOS 会将新版识别为另一款 App；数据目录保持不变。升级时先退出旧版，再用新版替换安装并打开；确认新版正常后再删除旧 App。bundle ID `com.codexfeishushare.app` 固定，新 App 自动更新 `runtime.json`；Hook 启动器不随版本改路径。

原图保存在 `icon/`。正式 App 使用 `app-white.png` 的白底版（图案有细微重绘），Dock 继续使用 `duck2.png`；状态栏使用 `tray-compact.png` 的透明黑色紧凑图案，输出 24×18 和 Retina 48×36 两份模板。打包自动生成 App `.icns`，并携带两份状态栏资源。

## 本地开发

```sh
npm ci --ignore-scripts
node scripts/prepare-electron.mjs
node node_modules/esbuild/install.js
npm run cli:prepare
npm run build
npm start
```

只准备锁文件中的 Electron / esbuild，不改本机 npm 的构建审批设置。Electron 归档按锁定校验值检查，再用 macOS `ditto` 解压并检查完整性。私有 CLI 构建需要 Go；运行已经打包的 App 无需 Node、Go 或本机 lark-cli。功能全部完成后再由指定测试 agent 运行 `npm test` 和必要的编译/计时检查，打包入口不夹带测试。

## 交付检查

本轮编译、合成正文核心断言及桌面回归已通过：隐藏程序坞时双击再开、已配置 App 手动启动开窗、登录自启静默，以及既有后台分享和错误脱敏流程。系统登录项、Dock 和飞书服务使用模拟。此前计时及真实应用切换结果继续保留，详细范围见 [验收记录.md](验收记录.md)。

开发者检查入口：`npm test`，加 `-- --synthetic` 可仅使用合成正文。桌面回归：`./node_modules/.bin/electron tests/desktop-regression.cjs`，另有 `login-startup`、`configured-startup`、`development` 场景；全部系统设置和飞书服务为模拟，不调用系统剪贴板。

独立窗口计时入口：`./node_modules/.bin/electron tests/window-benchmark.cjs`，会临时写入剪贴板；纯文本和图片只在内存保存并核对恢复，HTML、URI 或其他不能严格恢复的格式会在写入前停止。真实正文 fixture 可通过 `--fixture` 指定，仅在运行时读取，不入 Git。补丁检查先执行 `npm run cli:prepare` 准备固定源码归档。

真实飞书 OAuth、真实人员/群消息、飞书最终排版、同 App ID 的两个真实登录、人工复制/UI 核对及 DMG 安装升级，需要用户后续验证。Mock 成功不算真实链路通过。本轮不读取本机凭据、不触发真实授权、不发真实消息、不安装或信任全局 Hook，也不调用 computeruse。
