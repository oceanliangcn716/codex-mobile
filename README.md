# Codex Mobile（实验版）

用手机 Safari 查看和继续 Mac 上的 Codex 对话，可添加到主屏幕。支持文字、照片、文件、审批、问题卡以及模型和思考强度设置。

本项目是独立的本地工具，与 OpenAI 无隶属或背书关系。它使用桌面应用的内部 IPC 协议；桌面应用更新后可能需要适配，不是官方 Remote Control。

## 怎么同步

- 桌面已经持有的对话：通过桌面 IPC 发现归属，把开始、补充、停止和审批等操作交给原执行进程。
- 手机新建、或没有桌面持有者的历史对话：使用本机 Codex app-server 执行，复用用户自己的配置和对话存储。
- 当前轮次的模型/思考强度与下一轮设置分别显示；未知值不擅自伪装成菜单默认项。
- 使用 SSE 推送变化，页面按需读取对话。支持本地附件及 HEIC 转换。

## 安装

要求 macOS、可工作的 Python 3.9+，并且本机 Codex 桌面应用已能正常使用。安装器会下载和校验独立 Node.js 24，无 npm 第三方依赖，不需要 sudo。

```bash
git clone https://github.com/oceanliangcn716/codex-mobile.git ~/.local/share/codex-mobile
cd ~/.local/share/codex-mobile
./install.sh
```

然后打开 Codex 桌面应用，双击桌面的 **Codex手机连接**。在 iPhone Safari 粘贴配对链接，完成后选择“分享 → 添加到主屏幕”。手机在外时，先通过 Tailscale 或自己的 VPN 接入 Mac 所在局域网。

如果主屏幕入口丢失授权，回到原入口重新粘贴专属链接配对即可。不要把配对链接发给别人。

## 配置与维护

第一次安装会从 `config.example.json` 创建 `config.json`，已有配置保留。

- `bind_host`：默认 `auto`，启动时选择局域网地址。
- `port`：默认 `3083`。
- `cli_path`：可选，显式指定本机 Codex CLI 路径；也可使用 `CODEX_CLI_PATH` 环境变量。自动查找标准安装位置，最后尝试 PATH 中的 `codex`。
- `state_db_path`：可选，指定对话索引数据库路径。当前适配 `state_5.sqlite`，数据库结构更新后可能需要修改代码。

终端可用 `CODEX_HOME` 指定配置目录；登录服务不会自动继承终端里临时设置的环境变量。需要自定义服务环境时修改该服务的 plist。

```bash
# 仅准备文件和连接工具，不注册或启动服务
INSTALL_NO_START=1 ./install.sh
# 手动运行（需已有 Node.js 24+，或使用安装器准备的 runtime/node/bin/node）
node server.mjs
# 重启安装器注册的服务
launchctl kickstart -k gui/$(id -u)/local.$(id -u).codex-mobile
# 卸载自己的登录服务和连接工具，保留程序及用户数据
./uninstall.sh
```

已有旧服务占用端口时，请先停止旧服务。安装器不会删除或停止其他服务。IP 发生变化后，本版本需要重新启动服务并重新复制连接链接。

## 隐私与安全

发布包只包含工具源码、通用示例和测试。没有用户的对话、附件、配对密钥、账号凭据、原始调试说明或截图。图标由安装脚本生成，是通用手机图案，不包含厂商商标。

本工具不内置项目方服务器或遥测。它在本机读取 Codex 的会话索引及配置；模型请求仍交给用户自己配置的服务商，会产生相应的模型用量。上传附件保存在本目录 `private/uploads/`，不会自动删除。不要把 `private/`、配置、日志或整个运行目录直接提交到 Git。

HTTP 本身不提供 TLS，仅供可信局域网或加密 VPN 使用，不要映射到公网。配对授权有效期 30 天；删除 `private/pair.secret` 并重启会作废所有旧配对。

## 开发与发布

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --check server.mjs
# 仅检查已经纳入 Git 的文件，不读取个人凭据
git add <明确要发布的源文件>
node tools/check-release.mjs
```

测试只使用合成数据和临时目录，不调用付费模型，不读取真实对话。内部协议的兼容性与真实手机体验仍需在对应桌面版本上验证；未在另一台用户 Mac 或 Intel 真机上完成端到端安装验证。

下载包从 Git 提交导出，避免带入运行数据。许可证：[MIT](LICENSE)。Codex/OpenAI 商标与本机应用适用各自权利及条款，本仓库不分发官方应用或 CLI。

## 同步恢复修复

- 桌面重新打开对话或 IPC 重连后，手机会重新订阅实时状态。
- 实时快照暂时不可用时重新读取磁盘历史，避免永久返回旧缓存；发送前等待桌面快照，避免把运行中对话当作空闲。
- Safari 从后台恢复、网络恢复和事件流重连时补齐当前对话；前台每五秒校对一次，后台停止校对。
- 手机界面保持暗色，并针对 iPhone 17 Pro 排版。
