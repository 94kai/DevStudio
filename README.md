# DevStudio

DevStudio 是一个面向个人服务器的轻量开发工作台，通过浏览器管理项目并驱动 Codex 持续开发。

界面同时适配桌面端、手机和展开后的折叠屏。聊天页使用单行紧凑标题；矮屏会进一步隐藏副说明并减少顶部留白，桌面端聊天区则保持适中的阅读宽度。

当前界面包含三个主要功能：

- **对话开发**：连接常驻的 Codex App Server，展示执行过程，并按项目保存、切换会话。
- **项目预览**：把项目配置的本地端口或 URL 反向代理到 DevStudio 页面中，并支持浏览器原生全屏与铺满视口的兼容模式。
- **项目文件**：浏览项目中的文本文件，并在线创建或编辑 `AGENTS.md`。

支持创建和切换多个项目。不同项目拥有各自独立的会话列表与预览地址。

创建项目时，DevStudio 会读取根目录的 `template.md`，替换项目名称、路径和开发服务地址后生成项目的 `AGENTS.md`。生成内容只描述项目自身的开发约定，不向 Codex 暴露工作台实现；已有 `AGENTS.md` 不会被覆盖。

## 快速启动

需要 Node.js 20+，并确保当前系统中的 Codex 已完成登录。

```bash
cp .env.example .env
npm start
```

默认访问地址为 `http://127.0.0.1:8787`。如果部署到服务器，建议在前面配置 HTTPS 反向代理，并设置 `DEVSTUDIO_TOKEN`。

## 常用配置

- `PORT`：DevStudio 服务端口，默认 `8787`。
- `HOST`：监听地址，默认 `0.0.0.0`。
- `PROJECT_DIR`：首次启动时的默认项目目录。
- `PROJECTS_ROOT`：只填写项目名称时的创建根目录；默认是 DevStudio 同级的 `DevStudioProject`。
- `PREVIEW_URL`：首次启动时默认项目的预览地址，可填写完整 URL 或端口号。
- `DEVSTUDIO_TOKEN`：个人访问令牌，建议服务器部署时务必设置。
- `CODEX_BIN`：Codex 可执行文件，默认 `codex`。
- `CODEX_MODEL`：可选的 Codex 模型覆盖配置。
- `CODEX_SANDBOX`：Codex 沙箱模式，默认 `workspace-write`。

项目、会话和聊天记录保存在 `.devstudio/state.json`。Codex App Server 会在 DevStudio 运行期间常驻；项目的开发服务仍需由项目自身启动。

更完整的架构、数据结构、接口和已知限制见 [doc.md](./doc.md)。

## 文档维护

功能、接口、配置、数据结构或部署方式发生变化时，需要同步更新 `README.md` 和 `doc.md`：README 保持简洁，`doc.md` 记录实现细节。
