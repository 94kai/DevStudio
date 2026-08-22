# DevStudio 开发文档

本文档记录 DevStudio 当前的产品边界、实现结构和维护约定，供后续 Agent 继续迭代时参考。项目概览和启动方式见 [README.md](./README.md)。

## 1. 产品定位

DevStudio 是供个人使用的浏览器开发工作台。后端运行 Codex App Server，前端负责发送需求、展示执行过程、切换项目和会话，并预览正在开发的 Web 项目。

系统不对接 SSO。服务器部署时通过 `DEVSTUDIO_TOKEN` 提供简单的个人访问保护，生产环境仍应配合 HTTPS 和网络访问控制。

## 2. 当前功能

### 2.1 对话开发

- 后端启动一个常驻的 `codex app-server --listen stdio://` 子进程。
- 前端提交需求后，后端通过 JSON-RPC 创建或恢复线程，再启动 Codex turn。
- Codex 的状态、文本和工具执行过程通过 SSE 实时发送到浏览器。
- Codex 工作期间输入区不可输入，可通过停止按钮中断当前任务。
- 项目与会话一一归属；切换项目后只显示该项目的会话。

### 2.2 项目管理

- 支持创建项目、切换项目和修改已有项目的预览地址。
- 创建项目时只填写名称，会在 `PROJECTS_ROOT` 下创建对应目录。
- 相对路径同样相对于 `PROJECTS_ROOT`；绝对路径直接使用。
- 默认 `PROJECTS_ROOT` 是 DevStudio 所在目录的上一级中的 `DevStudioProject`。
- 新建项目时读取 DevStudio 根目录的 `template.md`，替换项目名称、绝对路径、预览地址和初始化时间后生成项目根目录的 `AGENTS.md`。
- 如果目标目录已经存在 `AGENTS.md`，保留已有内容，不使用模板覆盖。
- 模板让空项目在第一次 Codex 对话前就具备开发模式、公共规则、开发端口和文档维护约定。
- 生成的 `AGENTS.md` 只采用项目自身视角，不包含 DevStudio 名称、代理机制等宿主实现信息。

### 2.3 项目预览

- 预览地址支持完整 URL、纯端口号或 `:端口号`。
- 例如 `3000` 会规范化为 `http://127.0.0.1:3000`。
- 浏览器访问 `/preview/`，DevStudio 后端再把 HTTP 请求反向代理到项目预览地址。
- 预览地址只是代理配置，目前不会自动注入 Codex 上下文，也不会自动启动项目开发服务。项目应在 `AGENTS.md`、用户需求或项目配置中明确启动端口，并自行运行对应服务。
- 预览工具栏提供全屏按钮。支持时优先进入浏览器原生全屏；浏览器拒绝或不支持 Fullscreen API 时，仍会使用铺满网页视口的兼容模式。
- 全屏模式隐藏 DevStudio 顶栏、底部导航、预览标题和设备边框，仅在右上角保留退出按钮；再次点击或按 `Escape` 可以退出。

### 2.4 文件浏览

- “项目文件”页展示当前项目中的文本文件。
- 普通文本文件只读预览。
- `AGENTS.md` 可以在线创建和编辑。
- 保存 `AGENTS.md` 后，后续 Codex turn 会重新恢复线程，使新的项目指令生效。

### 2.5 移动端布局

- 页面根节点、主区域和各面板均限制在当前视口宽度内，禁止页面级横向溢出。
- 手机顶栏隐藏品牌文字和模型徽标，只保留项目选择、连接状态与设置入口，避免固定控件共同撑宽页面。
- 聊天页不展示 `AI DEVELOPMENT SPACE` 英文眉题，会话标题在所有尺寸下均保持单行并在过长时省略。
- 手机以及高度不超过 `720px` 的矮屏设备会隐藏副说明、缩小标题，并压缩顶栏、底栏和顶部留白；因此折叠屏展开后不会仅因宽度增加而恢复大标题。
- 预览工具栏允许标题区域收缩并截断长路径，操作按钮保持固定触控尺寸。
- 对话标题、文件区域和弹窗中的长文本均允许所在容器收缩，内部需要横向查看的代码或文件树不扩大页面宽度。
- 桌面端聊天面板最大宽度为 `1180px`，在空间利用率和左右视线移动距离之间取中间值；单条消息正文仍保留适合阅读的行宽。

## 3. 运行结构

```text
浏览器
  ├─ HTTP API：项目、会话、文件和任务操作
  ├─ SSE：接收 Codex 实时事件
  └─ /preview/*：访问项目预览
          │
DevStudio server.mjs
  ├─ .devstudio/state.json：持久化项目、会话和消息
  ├─ Codex App Server：常驻 stdio JSON-RPC 子进程
  └─ Preview Proxy：转发到当前项目 previewUrl
```

主要文件：

- `server.mjs`：HTTP 服务、状态持久化、Codex App Server 客户端和预览代理。
- `public/index.html`：页面结构。
- `public/app.js`：前端状态、接口调用、SSE 和交互逻辑。
- `public/styles.css`：桌面端和移动端样式。
- `.devstudio/state.json`：运行时生成的持久化状态。
- `AGENTS.md`：开发本项目时 Codex 自动读取的约定。
- `template.md`：新项目 `AGENTS.md` 的源模板，支持项目变量占位符。
- `.env.example`：环境变量示例。
- `ecosystem.config.cjs`：PM2 进程定义，固定运行目录并加载项目根目录的 `.env`。

`template.md` 支持以下占位符：

| 占位符 | 创建项目时替换为 |
| --- | --- |
| `{{PROJECT_NAME}}` | 用户填写的项目名称 |
| `{{PROJECT_PATH}}` | 项目绝对路径 |
| `{{PREVIEW_URL}}` | 规范化后的项目开发服务 URL |
| `{{CREATED_AT}}` | ISO 格式的初始化时间 |

## 4. 状态与数据

状态保存在 DevStudio 根目录的 `.devstudio/state.json`，核心结构如下：

```json
{
  "activeProjectId": "project-id",
  "projects": [
    {
      "id": "project-id",
      "name": "项目名称",
      "path": "/absolute/project/path",
      "previewUrl": "http://127.0.0.1:3000",
      "activeSessionId": "session-id",
      "sessions": [
        {
          "id": "session-id",
          "title": "会话标题",
          "threadId": "codex-thread-id",
          "messages": []
        }
      ]
    }
  ]
}
```

实现约束：

- 聊天消息会持久化，每个会话最多保留最近 100 条。
- Codex 的中间进度事件只实时推送，不完整持久化，也不会在断线重连后全部重放。
- 不同浏览器读取同一份服务端状态，因此可以看到历史项目、会话和消息。
- 当前激活项目和激活会话是服务端全局状态；多个浏览器同时操作时会相互影响。

## 5. Codex 生命周期

1. DevStudio 启动时拉起常驻 App Server。
2. 完成 JSON-RPC `initialize` 后，后端保持进程与连接。
3. 新会话首次执行时创建 Codex thread；已有会话恢复其 `threadId`。
4. 每次需求通过 turn 启动，事件持续转发给 SSE 客户端。
5. 收到 turn 完成或失败事件后，更新持久化消息与前端状态。
6. 停止任务时向 App Server 发送中断请求。

项目路径作为 Codex 工作目录。DevStudio 不再额外注入固定开发指令，Codex 按其标准规则自动读取项目目录中的 `AGENTS.md`。

## 6. HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 获取当前项目、会话和运行状态 |
| GET | `/api/projects` | 获取项目列表 |
| POST | `/api/projects` | 创建项目 |
| POST | `/api/projects/switch` | 切换当前项目 |
| POST | `/api/projects/update-preview` | 修改当前项目预览地址 |
| GET | `/api/sessions` | 获取当前项目的会话列表 |
| POST | `/api/sessions` | 创建会话 |
| POST | `/api/sessions/switch` | 切换会话 |
| GET | `/api/files` | 获取当前项目文件列表 |
| GET | `/api/file` | 读取文本文件 |
| PUT | `/api/file` | 保存允许编辑的文件，目前仅 `AGENTS.md` |
| GET | `/api/events` | 建立 SSE 实时事件连接 |
| POST | `/api/tasks` | 提交 Codex 开发需求 |
| POST | `/api/stop` | 中断当前任务 |
| POST | `/api/session/reset` | 兼容旧前端的新会话接口 |
| ALL | `/preview/*` | 代理当前项目的预览服务 |

设置 `DEVSTUDIO_TOKEN` 后，前端和 API 请求需要携带对应令牌。

## 7. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | DevStudio 监听地址 |
| `PROJECT_DIR` | DevStudio 当前目录 | 首次启动的默认项目目录 |
| `PROJECTS_ROOT` | 同级 `DevStudioProject` | 名称或相对路径项目的根目录 |
| `PREVIEW_URL` | 空 | 首次启动默认项目的预览地址 |
| `DEVSTUDIO_TOKEN` | 空 | 个人访问令牌 |
| `CODEX_BIN` | `codex` | Codex 命令路径 |
| `CODEX_MODEL` | 空 | 可选模型覆盖 |
| `CODEX_SANDBOX` | `workspace-write` | Codex 沙箱模式 |

DevStudio HTTP 端口固定为 `2005`，不接受环境变量覆盖。其他环境变量主要用于首次初始化和进程级配置。创建后的项目路径、会话和预览地址以 `.devstudio/state.json` 中的值为准。

## 8. 部署与安全

- 后端要求 Node.js 20+ 和已登录的 Codex CLI/App Server。
- 可通过 `npm run pm2:start` 按 `ecosystem.config.cjs` 启动单实例。进程异常退出后等待 3 秒自动重启，内存超过 1 GB 时自动重启。
- PM2 配置启动时读取项目根目录的 `.env`；调用 PM2 的外部环境变量优先于文件内同名变量。修改配置后使用 `npm run pm2:restart` 和 `--update-env` 更新进程环境。
- 系统级开机恢复需要先执行 `pm2 startup`，按其提示执行生成的系统命令，再执行 `pm2 save` 保存当前进程列表。该步骤与服务器的 init 系统和当前用户相关，不能仅靠仓库配置自动完成。
- DevStudio 进程、Codex App Server 和项目开发服务是不同进程；正式部署时应分别使用进程管理器维护。
- 对公网开放时应设置高强度 `DEVSTUDIO_TOKEN`，并通过 Nginx、Caddy 等配置 HTTPS。
- Codex 可以修改项目文件并执行命令，因此不要把服务暴露给不可信用户。
- 预览代理能够访问服务器本机地址，项目预览地址只应由可信用户配置。

## 9. 当前限制

- 预览代理主要支持普通 HTTP 请求，尚未专门处理 WebSocket/HMR 转发。
- DevStudio 不负责启动、重启或监控项目自身的开发服务器。
- 预览端口不会自动告知 Codex。
- 中间执行事件不会在网络重连后完整补发。
- 激活项目、激活会话和运行中的 Codex 任务尚未按用户或浏览器隔离。
- 当前访问令牌是个人使用场景下的轻量保护，不是完整账号和权限系统。

## 10. 文档维护约定

每次修改功能、接口、配置项、持久化结构、部署方式或重要行为后：

1. 更新 `doc.md`，准确记录当前实现、边界和已知限制。
2. 更新 `README.md`，保持产品概览、启动方法和主要配置与实现一致。
3. 不在文档中描述尚未实现的功能；规划内容必须明确标记为规划。
