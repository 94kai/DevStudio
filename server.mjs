import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");
const DATA_DIR = join(ROOT_DIR, ".devstudio");
const STATE_FILE = join(DATA_DIR, "state.json");
const PROJECT_TEMPLATE_FILE = join(ROOT_DIR, "template.md");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_PROJECT_DIR = resolve(process.env.PROJECT_DIR || ROOT_DIR);
const DEFAULT_PREVIEW_URL = process.env.PREVIEW_URL || "http://127.0.0.1:3000";
const PROJECTS_ROOT = resolve(process.env.PROJECTS_ROOT || join(dirname(ROOT_DIR), "DevStudioProject"));
const ACCESS_TOKEN = process.env.DEVSTUDIO_TOKEN || "";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "danger-full-access";

mkdirSync(DATA_DIR, { recursive: true });

let state = loadState();
let activeProcess = null;
let activeTask = null;
let activeModel = detectModel();
let appServerReady = null;
let connectedThreadId = null;
let rpcSequence = 0;
const pendingRequests = new Map();
const listeners = new Set();

function detectModel() {
  if (CODEX_MODEL) return CODEX_MODEL;
  const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  try {
    const config = readFileSync(configPath, "utf8");
    const topLevel = config.split(/^\s*\[/m, 1)[0];
    return topLevel.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || "默认模型";
  } catch {
    return "默认模型";
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (Array.isArray(parsed.projects) && parsed.projects.length) {
      const projects = parsed.projects.map((project) => {
        const sessions = Array.isArray(project.sessions) && project.sessions.length ? project.sessions : [createSession()];
        return { ...project, sessions, activeSessionId: sessions.some((session) => session.id === project.activeSessionId) ? project.activeSessionId : sessions[0].id };
      });
      const activeProject = projects.find((project) => project.id === parsed.activeProjectId) || projects[0];
      const activeSession = activeProject.sessions.find((session) => session.id === parsed.activeSessionId || session.id === activeProject.activeSessionId) || activeProject.sessions[0];
      return {
        projects,
        activeProjectId: activeProject.id,
        activeSessionId: activeSession.id,
        status: "idle"
      };
    }
    const migratedSession = createSession({
      threadId: parsed.sessionId || null,
      messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-100) : [],
      title: parsed.messages?.find((message) => message.role === "user")?.content?.slice(0, 32) || "原有会话"
    });
    const migratedProject = createProject({
      name: basename(DEFAULT_PROJECT_DIR),
      path: DEFAULT_PROJECT_DIR,
      previewUrl: DEFAULT_PREVIEW_URL,
      sessions: [migratedSession]
    });
    migratedProject.activeSessionId = migratedSession.id;
    return {
      projects: [migratedProject],
      activeProjectId: migratedProject.id,
      activeSessionId: migratedSession.id,
      status: "idle"
    };
  } catch {
    const session = createSession();
    const project = createProject({
      name: basename(DEFAULT_PROJECT_DIR),
      path: DEFAULT_PROJECT_DIR,
      previewUrl: DEFAULT_PREVIEW_URL,
      sessions: [session]
    });
    project.activeSessionId = session.id;
    return { projects: [project], activeProjectId: project.id, activeSessionId: session.id, status: "idle" };
  }
}

function createSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: "新会话",
    threadId: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createProject(overrides = {}) {
  return {
    id: randomUUID(),
    name: "未命名项目",
    path: DEFAULT_PROJECT_DIR,
    previewUrl: DEFAULT_PREVIEW_URL,
    createdAt: new Date().toISOString(),
    sessions: [],
    activeSessionId: null,
    ...overrides
  };
}

function initializeProjectInstructions(projectPath, project) {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (existsSync(agentsPath)) return false;
  const template = readFileSync(PROJECT_TEMPLATE_FILE, "utf8")
    .replaceAll("{{PROJECT_NAME}}", project.name)
    .replaceAll("{{PROJECT_PATH}}", project.path)
    .replaceAll("{{PREVIEW_URL}}", project.previewUrl)
    .replaceAll("{{CREATED_AT}}", new Date().toISOString());
  writeFileSync(agentsPath, template, "utf8");
  return true;
}

function getActiveProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
}

function getActiveSession() {
  const project = getActiveProject();
  return project.sessions.find((session) => session.id === state.activeSessionId) || project.sessions[0];
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify({
    projects: state.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({ ...session, messages: session.messages.slice(-100) }))
    })),
    activeProjectId: state.activeProjectId,
    activeSessionId: state.activeSessionId
  }, null, 2));
}

saveState();

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    previewUrl: project.previewUrl,
    sessionCount: project.sessions.length,
    createdAt: project.createdAt
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    threadId: session.threadId,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function parsePreviewUrl(value) {
  const rawValue = String(value || DEFAULT_PREVIEW_URL).trim();
  const normalizedValue = /^:?\d{1,5}$/.test(rawValue)
    ? `http://127.0.0.1:${rawValue.replace(/^:/, "")}`
    : /^[\w.-]+:\d{1,5}$/.test(rawValue) ? `http://${rawValue}` : rawValue;
  const previewUrl = new URL(normalizedValue);
  if (previewUrl.protocol !== "http:") throw new Error("预览地址目前只支持 http://");
  const port = Number(previewUrl.port || 80);
  if (port < 1 || port > 65535) throw new Error("预览端口必须在 1 到 65535 之间");
  return previewUrl;
}

function resolveProjectFile(relativePath = "") {
  const projectRoot = resolve(getActiveProject().path);
  const cleaned = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  const filePath = resolve(projectRoot, cleaned || ".");
  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${sep}`)) throw new Error("文件路径超出当前项目范围");
  return filePath;
}

function listProjectFiles() {
  const ignored = new Set([".git", "node_modules", ".devstudio", "dist", "build"]);
  let count = 0;
  function walk(directory, relativeDirectory = "", depth = 0) {
    if (depth > 4 || count >= 600) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env.example")
      .filter((entry) => !ignored.has(entry.name) && !entry.isSymbolicLink())
      .sort((first, second) => Number(second.isDirectory()) - Number(first.isDirectory()) || first.name.localeCompare(second.name, "zh-CN", { numeric: true }))
      .map((entry) => {
        count += 1;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return { name: entry.name, path: relativePath, type: "directory", children: walk(join(directory, entry.name), relativePath, depth + 1) };
        }
        return { name: entry.name, path: relativePath, type: "file", editable: entry.name.toUpperCase() === "AGENTS.MD" };
      });
  }
  return walk(resolve(getActiveProject().path));
}

function readProjectFile(relativePath) {
  const filePath = resolveProjectFile(relativePath);
  const fileStats = statSync(filePath);
  if (!fileStats.isFile()) throw new Error("请选择一个文件");
  if (fileStats.size > 1024 * 1024) throw new Error("文件超过 1MB，暂不支持在线预览");
  const content = readFileSync(filePath);
  if (content.includes(0)) throw new Error("二进制文件暂不支持在线预览");
  return {
    path: String(relativePath).replaceAll("\\", "/"),
    content: content.toString("utf8"),
    editable: basename(filePath).toUpperCase() === "AGENTS.MD",
    modifiedAt: fileStats.mtime.toISOString()
  };
}

function writeAgentsFile(relativePath, content) {
  const filePath = resolveProjectFile(relativePath || "AGENTS.md");
  if (basename(filePath).toUpperCase() !== "AGENTS.MD") throw new Error("目前只允许编辑 AGENTS.md");
  if (String(content).length > 1024 * 1024) throw new Error("文件内容超过 1MB");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, String(content), "utf8");
  connectedThreadId = null;
  return readProjectFile(relativePath || "AGENTS.md");
}

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch {
        rejectBody(new Error("请求内容不是有效 JSON"));
      }
    });
    request.on("error", rejectBody);
  });
}

function isAuthorized(request, url) {
  if (!ACCESS_TOKEN) return true;
  const authorization = request.headers.authorization || "";
  const cookies = Object.fromEntries((request.headers.cookie || "").split(";").map((item) => {
    const [key, ...parts] = item.trim().split("=");
    return [key, decodeURIComponent(parts.join("="))];
  }).filter(([key]) => key));
  return authorization === `Bearer ${ACCESS_TOKEN}` || url.searchParams.get("token") === ACCESS_TOKEN || cookies.devstudio_token === ACCESS_TOKEN;
}

function broadcast(type, payload = {}) {
  const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of listeners) response.write(event);
}

function addMessage(role, content, extra = {}) {
  const session = getActiveSession();
  const message = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra
  };
  session.messages.push(message);
  session.updatedAt = message.createdAt;
  if (role === "user" && session.title === "新会话") session.title = content.replace(/\s+/g, " ").slice(0, 32);
  saveState();
  broadcast("message", { ...message, projectId: state.activeProjectId, sessionId: session.id });
  return message;
}

function rpcCallRaw(method, params) {
  return new Promise((resolveCall, rejectCall) => {
    if (!activeProcess?.stdin.writable) return rejectCall(new Error("Codex App Server 尚未连接"));
    const id = ++rpcSequence;
    pendingRequests.set(id, { resolve: resolveCall, reject: rejectCall });
    activeProcess.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function rpcCall(method, params) {
  await startAppServer();
  return rpcCallRaw(method, params);
}

function normalizeItem(item = {}) {
  if (item.type === "agentMessage") return { ...item, type: "agent_message" };
  if (item.type === "commandExecution") return {
    ...item,
    type: "command_execution",
    aggregated_output: item.aggregatedOutput,
    exit_code: item.exitCode
  };
  if (item.type === "fileChange") return { ...item, type: "file_change" };
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return { ...item, type: "mcp_tool_call" };
  if (item.type === "webSearch") return { ...item, type: "web_search" };
  if (item.type === "reasoning") return { ...item, text: [...(item.summary || []), ...(item.content || [])].join("\n") };
  return item;
}

function handleAppServerNotification(message) {
  const { method, params = {} } = message;
  const taskId = activeTask?.taskId;
  if (method === "thread/started" && params.thread?.id) {
    getActiveSession().threadId = params.thread.id;
    connectedThreadId = params.thread.id;
    saveState();
    if (taskId) broadcast("progress", { taskId, event: { type: "thread.started" } });
    return;
  }
  if (params.threadId && getActiveSession().threadId && params.threadId !== getActiveSession().threadId) return;
  if (method === "turn/started") {
    if (activeTask) activeTask.turnId = params.turn?.id || activeTask.turnId;
    if (taskId) broadcast("progress", { taskId, event: { type: "turn.started" } });
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    const eventType = method === "item/started" ? "item.started" : "item.completed";
    const item = normalizeItem(params.item);
    if (method === "item/completed" && item.type === "agent_message" && item.text) {
      addMessage("assistant", item.text, { taskId });
    }
    if (taskId) broadcast("progress", { taskId, event: { type: eventType, item } });
    return;
  }
  if (method === "item/commandExecution/outputDelta" && taskId && params.delta) {
    broadcast("log", { taskId, text: params.delta });
    return;
  }
  if (method === "turn/completed") {
    const turnStatus = params.turn?.status || "completed";
    const completedTaskId = taskId;
    state.status = turnStatus === "completed" ? "idle" : turnStatus === "interrupted" ? "idle" : "error";
    if (completedTaskId) {
      broadcast("progress", {
        taskId: completedTaskId,
        event: turnStatus === "failed" ? { type: "turn.failed", error: params.turn?.error } : { type: "turn.completed" }
      });
      if (turnStatus === "completed") broadcast("task-complete", { taskId: completedTaskId });
      if (turnStatus === "interrupted") addMessage("system", "任务已停止", { taskId: completedTaskId });
      if (turnStatus === "failed") addMessage("system", `任务执行失败：${params.turn?.error?.message || "未知错误"}`, { taskId: completedTaskId, error: true });
      broadcast("status", { status: state.status, taskId: completedTaskId });
    }
    activeTask = null;
    return;
  }
  if (method === "model/rerouted" && params.toModel) {
    activeModel = params.toModel;
    broadcast("model", { model: activeModel });
    return;
  }
  if (method === "error" && taskId) {
    broadcast("progress", { taskId, event: { type: "error", message: params.error?.message || params.message } });
  }
}

function consumeAppServerLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    if (activeTask) broadcast("log", { taskId: activeTask.taskId, text: line });
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error)) {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "Codex 请求失败"));
    else pending.resolve(message.result);
    return;
  }
  if (message.method) handleAppServerNotification(message);
}

function startAppServer() {
  if (appServerReady) return appServerReady;
  const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeProcess = child;
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) consumeAppServerLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (activeTask) broadcast("log", { taskId: activeTask.taskId, text: chunk });
    else process.stderr.write(chunk);
  });
  child.on("close", (code) => {
    activeProcess = null;
    appServerReady = null;
    connectedThreadId = null;
    for (const pending of pendingRequests.values()) pending.reject(new Error("Codex App Server 连接已断开"));
    pendingRequests.clear();
    if (activeTask) {
      const taskId = activeTask.taskId;
      addMessage("system", `Codex App Server 异常退出，退出码 ${code}`, { taskId, error: true });
      activeTask = null;
      state.status = "error";
      broadcast("status", { status: state.status, taskId });
    }
    setTimeout(() => startAppServer().catch(() => {}), 1000);
  });
  child.on("error", (error) => console.error(`Codex App Server 启动失败：${error.message}`));
  appServerReady = rpcCallRaw("initialize", {
    clientInfo: { name: "devstudio", title: "DevStudio", version: "1.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false }
  }).then((result) => {
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    console.log(`Codex App Server 已连接：${result.userAgent}`);
    return result;
  }).catch((error) => {
    appServerReady = null;
    child.kill("SIGTERM");
    throw error;
  });
  return appServerReady;
}

async function ensureThread() {
  const project = getActiveProject();
  const session = getActiveSession();
  const threadOptions = {
    cwd: project.path,
    approvalPolicy: "never",
    sandbox: CODEX_SANDBOX
  };
  if (CODEX_MODEL) threadOptions.model = CODEX_MODEL;
  if (session.threadId && connectedThreadId === session.threadId) return session.threadId;
  if (session.threadId) {
    try {
      const result = await rpcCall("thread/resume", { threadId: session.threadId, ...threadOptions });
      activeModel = result.model || activeModel;
      connectedThreadId = session.threadId;
      broadcast("model", { model: activeModel });
      return session.threadId;
    } catch {
      session.threadId = null;
      saveState();
    }
  }
  const result = await rpcCall("thread/start", { ...threadOptions, ephemeral: false });
  session.threadId = result.thread.id;
  connectedThreadId = result.thread.id;
  activeModel = result.model || activeModel;
  saveState();
  broadcast("model", { model: activeModel });
  return session.threadId;
}

function runTask(prompt) {
  const taskId = `${Date.now()}`;
  activeTask = { taskId, turnId: null };
  state.status = "running";
  addMessage("user", prompt, { taskId });
  broadcast("status", { status: state.status, taskId });
  void (async () => {
    try {
      const threadId = await ensureThread();
      const result = await rpcCall("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }]
      });
      if (activeTask?.taskId === taskId) activeTask.turnId = result.turn.id;
    } catch (error) {
      if (activeTask?.taskId !== taskId) return;
      addMessage("system", `任务启动失败：${error.message}`, { taskId, error: true });
      activeTask = null;
      state.status = "error";
      broadcast("status", { status: state.status, taskId });
    }
  })();
  return taskId;
}

function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!existsSync(filePath)) {
    sendJson(response, 404, { error: "页面不存在" });
    return;
  }
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extname(filePath)] || "application/octet-stream";
  response.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
  response.end(readFileSync(filePath));
}

function proxyPreview(request, response, url) {
  const previewUrl = new URL(getActiveProject().previewUrl || DEFAULT_PREVIEW_URL);
  const suffix = url.pathname.replace(/^\/preview/, "") || "/";
  const targetPath = `${previewUrl.pathname.replace(/\/$/, "")}${suffix}${url.search}`;
  const proxyRequest = http.request({
    protocol: previewUrl.protocol,
    hostname: previewUrl.hostname,
    port: previewUrl.port,
    method: request.method,
    path: targetPath,
    headers: { ...request.headers, host: previewUrl.host, "accept-encoding": "identity" }
  }, (proxyResponse) => {
    const headers = { ...proxyResponse.headers };
    delete headers["content-security-policy"];
    delete headers["x-frame-options"];
    const isHtml = String(headers["content-type"] || "").includes("text/html");
    if (!isHtml) {
      response.writeHead(proxyResponse.statusCode || 502, headers);
      proxyResponse.pipe(response);
      return;
    }
    const chunks = [];
    proxyResponse.on("data", (chunk) => chunks.push(chunk));
    proxyResponse.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      html = html.replace(/<(head)([^>]*)>/i, `<$1$2><base href="/preview/">`)
        .replace(/(src|href|action)="\/(?!preview\/)/g, `$1="/preview/`)
        .replace(/(src|href|action)='\/(?!preview\/)/g, `$1='/preview/`);
      delete headers["content-length"];
      headers["content-length"] = Buffer.byteLength(html);
      response.writeHead(proxyResponse.statusCode || 502, headers);
      response.end(html);
    });
  });
  proxyRequest.on("error", () => {
    response.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#f4f2ed;color:#272522;display:grid;place-items:center;height:100vh;margin:0;text-align:center}.box{max-width:360px;padding:32px}h2{font-size:20px}p{color:#777;line-height:1.6}</style><div class="box"><h2>预览服务尚未启动</h2><p>请让 Codex 启动项目，或检查 PREVIEW_URL 是否指向正确端口。</p></div>`);
  });
  request.pipe(proxyRequest);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/preview")) {
    if (!isAuthorized(request, url)) return sendJson(response, 401, { error: "访问令牌无效" });
    if (ACCESS_TOKEN && url.searchParams.get("token") === ACCESS_TOKEN) {
      response.setHeader("set-cookie", `devstudio_token=${encodeURIComponent(ACCESS_TOKEN)}; HttpOnly; SameSite=Lax; Path=/preview`);
    }
    return proxyPreview(request, response, url);
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthorized(request, url)) return sendJson(response, 401, { error: "访问令牌无效" });
    if (request.method === "GET" && url.pathname === "/api/state") {
      const project = getActiveProject();
      const session = getActiveSession();
      return sendJson(response, 200, {
        messages: session.messages,
        status: state.status,
        sessionId: session.id,
        threadId: session.threadId,
        model: activeModel,
        project: projectSummary(project),
        projects: state.projects.map(projectSummary),
        session: sessionSummary(session),
        sessions: project.sessions.map(sessionSummary).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)),
        projectDir: project.path,
        projectsRoot: PROJECTS_ROOT,
        previewUrl: "/preview/"
      });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(response, 200, { activeProjectId: state.activeProjectId, projects: state.projects.map(projectSummary) });
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      try {
        const body = await readJson(request);
        const name = String(body.name || "").trim();
        if (!name) return sendJson(response, 400, { error: "请输入项目名称" });
        const safeName = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || `project-${Date.now()}`;
        const pathInput = String(body.path || "").trim();
        const projectPath = pathInput
          ? isAbsolute(pathInput) ? resolve(pathInput) : resolve(PROJECTS_ROOT, pathInput)
          : resolve(PROJECTS_ROOT, safeName);
        if (projectPath === resolve("/") || projectPath === resolve(homedir())) return sendJson(response, 400, { error: "不能将系统根目录或用户主目录作为项目" });
        if (state.projects.some((project) => resolve(project.path) === projectPath)) return sendJson(response, 409, { error: "该项目路径已经存在，请直接切换" });
        if (existsSync(projectPath) && !statSync(projectPath).isDirectory()) return sendJson(response, 400, { error: "项目路径不是文件夹" });
        const previewUrl = parsePreviewUrl(body.previewUrl);
        mkdirSync(projectPath, { recursive: true });
        const session = createSession();
        const project = createProject({ name, path: projectPath, previewUrl: previewUrl.toString(), sessions: [session] });
        initializeProjectInstructions(projectPath, project);
        project.activeSessionId = session.id;
        state.projects.push(project);
        state.activeProjectId = project.id;
        state.activeSessionId = session.id;
        connectedThreadId = null;
        saveState();
        broadcast("context-changed", { projectId: project.id, sessionId: session.id });
        return sendJson(response, 201, { project: projectSummary(project), session: sessionSummary(session) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/projects/switch") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      try {
        const body = await readJson(request);
        const project = state.projects.find((item) => item.id === body.projectId);
        if (!project) return sendJson(response, 404, { error: "项目不存在" });
        state.activeProjectId = project.id;
        state.activeSessionId = project.activeSessionId || project.sessions[0].id;
        connectedThreadId = null;
        saveState();
        broadcast("context-changed", { projectId: project.id, sessionId: state.activeSessionId });
        return sendJson(response, 200, { switched: true });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/projects/update-preview") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      try {
        const body = await readJson(request);
        const project = state.projects.find((item) => item.id === body.projectId);
        if (!project) return sendJson(response, 404, { error: "项目不存在" });
        project.previewUrl = parsePreviewUrl(body.previewUrl).toString();
        saveState();
        broadcast("context-changed", { projectId: state.activeProjectId, sessionId: state.activeSessionId });
        return sendJson(response, 200, { project: projectSummary(project) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const project = getActiveProject();
      return sendJson(response, 200, {
        activeSessionId: state.activeSessionId,
        sessions: project.sessions.map(sessionSummary).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      });
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      const session = createSession();
      getActiveProject().sessions.unshift(session);
      getActiveProject().activeSessionId = session.id;
      state.activeSessionId = session.id;
      connectedThreadId = null;
      saveState();
      broadcast("context-changed", { projectId: state.activeProjectId, sessionId: session.id });
      return sendJson(response, 201, { session: sessionSummary(session) });
    }
    if (request.method === "POST" && url.pathname === "/api/sessions/switch") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      try {
        const body = await readJson(request);
        const session = getActiveProject().sessions.find((item) => item.id === body.sessionId);
        if (!session) return sendJson(response, 404, { error: "会话不存在" });
        state.activeSessionId = session.id;
        getActiveProject().activeSessionId = session.id;
        connectedThreadId = null;
        saveState();
        broadcast("context-changed", { projectId: state.activeProjectId, sessionId: session.id });
        return sendJson(response, 200, { switched: true });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/files") {
      try {
        return sendJson(response, 200, { files: listProjectFiles(), project: projectSummary(getActiveProject()) });
      } catch (error) {
        return sendJson(response, 500, { error: error.message });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/file") {
      try {
        return sendJson(response, 200, readProjectFile(url.searchParams.get("path") || ""));
      } catch (error) {
        return sendJson(response, error.code === "ENOENT" ? 404 : 400, { error: error.code === "ENOENT" ? "文件不存在" : error.message });
      }
    }
    if (request.method === "PUT" && url.pathname === "/api/file") {
      if (activeTask) return sendJson(response, 409, { error: "Codex 工作时暂不允许编辑文件" });
      try {
        const body = await readJson(request);
        return sendJson(response, 200, writeAgentsFile(body.path || "AGENTS.md", body.content || ""));
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      response.write(`event: status\ndata: ${JSON.stringify({ status: state.status })}\n\n`);
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tasks") {
      if (activeTask) return sendJson(response, 409, { error: "已有任务正在执行，请等待完成或先停止任务" });
      try {
        const body = await readJson(request);
        const prompt = String(body.prompt || "").trim();
        if (!prompt) return sendJson(response, 400, { error: "请输入开发需求" });
        if (prompt.length > 20000) return sendJson(response, 400, { error: "需求内容过长" });
        return sendJson(response, 202, { taskId: runTask(prompt) });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      const threadId = getActiveSession().threadId;
      if (!activeTask?.turnId || !threadId) return sendJson(response, 200, { stopped: false });
      try {
        await rpcCall("turn/interrupt", { threadId, turnId: activeTask.turnId });
        return sendJson(response, 200, { stopped: true });
      } catch (error) {
        return sendJson(response, 500, { error: error.message });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/session/reset") {
      if (activeTask) return sendJson(response, 409, { error: "请先等待当前任务完成" });
      const session = createSession();
      getActiveProject().sessions.unshift(session);
      getActiveProject().activeSessionId = session.id;
      state.activeSessionId = session.id;
      connectedThreadId = null;
      saveState();
      broadcast("context-changed", { projectId: state.activeProjectId, sessionId: session.id });
      return sendJson(response, 200, { reset: true, session: sessionSummary(session) });
    }
    return sendJson(response, 404, { error: "接口不存在" });
  }

  serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`DevStudio 已启动：http://${HOST}:${PORT}`);
  console.log(`当前项目：${getActiveProject().path}`);
  console.log(`预览地址：${getActiveProject().previewUrl}`);
  if (!ACCESS_TOKEN) console.warn("警告：未配置 DEVSTUDIO_TOKEN，请勿直接暴露到公网");
});

startAppServer().catch((error) => console.error(`Codex App Server 初始化失败：${error.message}`));
