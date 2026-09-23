# dsh-console

<p align="center">
  <h1 align="center">dsh-console</h1>
</p>

<p align="center">
  <strong>DSH 控制台插件——在 Web 界面直接开真 PTY 终端跑命令，不离开聊天上下文。</strong>
</p>

<p align="center">
  <a href="https://github.com/chinazkk/dsh-console/issues">Report an issue</a>
  · <a href="https://github.com/chinazkk/dsh-console">View on GitHub</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/DSH-Web%20Plugin-10b981" alt="DSH Web Plugin">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white" alt="Node.js 18 or later">
  <img src="https://img.shields.io/badge/bundle-dsh.bundle%2Bdsh.client-8b5cf6" alt="DSH bundle">
</p>

> dsh-console 是一个社区维护的 DSH 插件，非 DeepSeek 官方产品。

## 功能

- **主视图「控制台」标签页**：与「对话 / 轨迹 / 任务面板」同级，iTerm 风格深色多标签栏
- **真 PTY 交互终端**：每个标签一个独立 PTY 会话（node-pty 底层），vim / top / htop / ctrl+c 等交互式程序全支持
- **用户真实 shell 环境**：登录 shell（`$SHELL -l`）+ 完整环境变量透传 + 256 色，conda / git 状态提示符原样呈现
- **输出不丢**：host 侧 512KB 环形缓冲，切标签、刷新页面、断线重连后自动回放还原画面
- **多标签管理**：`+` 新建、`×` 关闭、绿点存活指示、状态栏显示 pid 与几何尺寸、一键清屏

## 安装

### 方式一：一键脚本（推荐）

```bash
# 解压后进入插件目录
cd dsh-console
./install.sh            # 复制到 ~/.dsh/profiles/web/ 并注册 bundles
# 然后重启 DSH，浏览器打开任意会话即可看到「控制台」标签
```

`install.sh` 做三件事：拷贝到 `~/.dsh/profiles/web/node_modules/dsh-console` → 在 profile `package.json` 的 `dsh.profile.bundles` 追加 `dsh-console` → 提示重启。重复执行安全（幂等）。

### 方式二：手动安装

```bash
# 1. 拷贝插件（lib/ 已构建，无需再 build）
cp -R dsh-console ~/.dsh/profiles/web/node_modules/dsh-console

# 2. 注册 bundle：编辑 ~/.dsh/profiles/web/package.json
#    dsh.profile.bundles 数组里加一行 "dsh-console"

# 3. 重启 DSH
```

> 包内 `lib/` 已是构建产物，外部安装无需 Node 工具链。仅修改源码重新构建时才需要 `pnpm install && pnpm build`。

## 使用

1. 重启 DSH 后浏览器打开 `http://127.0.0.1:3080`，进入任意会话
2. 顶部标签栏出现「控制台」（位于「轨迹」与「任务面板」之间）
3. 点 `+` 或「新建终端」开一个 PTY 标签，直接键入命令
4. 关闭 DSH 前记得保存终端里的工作（PTY 会话不跨 DSH 重启，与 iTerm 关窗一致）

## 架构

```
浏览器 (xterm.js, 每标签常驻实例)
  ├── 下行: EventSource GET /plugins/dsh-console/stream?tab=<id>
  │         连接即回放环形缓冲 → 实时转发 PTY 输出（SSE, 15s 心跳）
  └── 上行: POST /plugins/dsh-console/rpc
            tab.list / tab.open(cwd?) / tab.close(id) / tab.write(id, data)

DSH host 半 (src/index.ts)
  ├── ctx.subprocess.spawnTerminal → 用户登录 shell + process.env
  ├── host 侧常驻泵: PTY 输出 → 512KB 环形缓冲 + 广播订阅者
  └── 插件卸载/DSH 退出: terminate 全部 PTY
```

- **host 半**（`src/index.ts`）：RPC + SSE 路由注册到 `ctx.webServer`，PTY 生命周期与标签注册表
- **client 半**（`src/client/index.ts`）：React 组件 + xterm.js，经 `slots.inject('conversation.view')` 注册主视图标签页；xterm 及 CSS 全部内联进单个 bundle（`lib/client.js`，约 400KB），无外部资源依赖
- **构建**：`tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown`（client 走 harness 的 ModuleLoader 打包协议）

## 已知限制（v1）

| 限制 | 原因 | 方向 |
|------|------|------|
| 固定 120×34，无 resize | DSH subprocess seam 未暴露 resize API | v2 走 DSH 源码补丁注册表加 p10 |
| PTY 会话不跨 DSH 重启 | 标签注册表为进程内存态 | 与 iTerm 关窗一致，属预期行为 |
| 终端标题固定「终端 N」 | 未解析 OSC 标题序列 | 可从输出流解析 `\x1b]0;` 动态更新 |

## 开发

```bash
pnpm install && pnpm build     # 构建 host + client bundle
# 重新部署到本机 profile：
cp -R . ~/.dsh/profiles/web/node_modules/dsh-console
# 重启 DSH 后生效
```

修改 client 半后必须重跑完整 `pnpm build`（tsdown 会重新内联 xterm）。

## 环境要求

- DSH (DeepSeek Harness) `--profile web` 运行环境
- Node.js ≥ 18（仅构建需要；安装预构建包不需要）
