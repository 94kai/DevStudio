const $ = (selector) => document.querySelector(selector);
const tokenKey = "devstudio-token";
let token = localStorage.getItem(tokenKey) || "";
let eventSource = null;
let currentStatus = "idle";
let toastTimer = null;
let currentProject = null;
let currentSession = null;
let availableProjects = [];
let availableSessions = [];
let selectedFile = null;
let fileTreeLoadedFor = null;

const elements = {
  connection: $("#connection"),
  projectButton: $("#projectButton"),
  projectButtonName: $("#projectButtonName"),
  modelBadge: $("#modelBadge"),
  messages: $("#messages"),
  emptyState: $("#emptyState"),
  composer: $("#composer"),
  input: $("#promptInput"),
  send: $("#sendButton"),
  stop: $("#stopButton"),
  preview: $("#previewFrame"),
  projectPath: $("#projectPath"),
  sessionTitle: $("#sessionTitle"),
  chatSubtitle: $("#chatSubtitle"),
  projectsDialog: $("#projectsDialog"),
  projectsList: $("#projectsList"),
  projectPreviewDialog: $("#projectPreviewDialog"),
  sessionsDialog: $("#sessionsDialog"),
  sessionsList: $("#sessionsList"),
  sessionsProjectName: $("#sessionsProjectName"),
  fileTree: $("#fileTree"),
  filesProjectPath: $("#filesProjectPath"),
  fileEditor: $("#fileEditor"),
  filePlaceholder: $("#filePlaceholder"),
  fileViewerName: $("#fileViewerName"),
  fileViewerMeta: $("#fileViewerMeta"),
  saveFile: $("#saveFileButton"),
  dialog: $("#settingsDialog"),
  tokenInput: $("#tokenInput"),
  toast: $("#toast")
};

function authUrl(path) {
  const url = new URL(path, window.location.origin);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function setConnection(kind, text) {
  elements.connection.className = `connection ${kind}`;
  elements.connection.querySelector("span").textContent = text;
}

function setStatus(status) {
  currentStatus = status;
  const running = status === "running";
  elements.send.classList.toggle("hidden", running);
  elements.stop.classList.toggle("hidden", !running);
  elements.input.disabled = running;
  setConnection(status === "error" ? "offline" : "online", running ? "Codex 工作中" : status === "error" ? "任务异常" : "已连接");
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatRelativeTime(value) {
  if (!value) return "刚刚";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function renderProjects() {
  elements.projectsList.replaceChildren();
  $("#currentProjectPreview").textContent = currentProject?.previewUrl || "";
  for (const project of availableProjects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `selection-item${project.id === currentProject?.id ? " active" : ""}`;
    button.innerHTML = `<span class="selection-avatar"></span><div><strong></strong><span></span></div><span class="selection-check">${project.id === currentProject?.id ? "✓" : ""}</span>`;
    button.querySelector(".selection-avatar").textContent = project.name.slice(0, 1).toUpperCase();
    button.querySelector("strong").textContent = project.name;
    button.querySelector("div span").textContent = `${project.path} · ${project.sessionCount} 个会话`;
    button.addEventListener("click", async () => {
      if (project.id === currentProject?.id) return elements.projectsDialog.close();
      try {
        await api("/api/projects/switch", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
        elements.projectsDialog.close();
        await loadState();
        showToast(`已切换到 ${project.name}`);
      } catch (error) { showToast(error.message); }
    });
    elements.projectsList.append(button);
  }
}

function editablePreviewValue(previewUrl) {
  try {
    const parsed = new URL(previewUrl);
    if (["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      return parsed.port || "80";
    }
  } catch {
    return previewUrl || "";
  }
  return previewUrl || "";
}

function renderSessions() {
  elements.sessionsList.replaceChildren();
  elements.sessionsProjectName.textContent = currentProject ? `${currentProject.name} · ${availableSessions.length} 个会话` : "";
  for (const session of availableSessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `selection-item${session.id === currentSession?.id ? " active" : ""}`;
    button.innerHTML = `<span class="selection-avatar">✦</span><div><strong></strong><span></span></div><span class="selection-check">${session.id === currentSession?.id ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = session.title || "新会话";
    button.querySelector("div span").textContent = `${formatRelativeTime(session.updatedAt)} · ${session.messageCount} 条消息`;
    button.addEventListener("click", async () => {
      if (session.id === currentSession?.id) return elements.sessionsDialog.close();
      try {
        await api("/api/sessions/switch", { method: "POST", body: JSON.stringify({ sessionId: session.id }) });
        elements.sessionsDialog.close();
        await loadState();
      } catch (error) { showToast(error.message); }
    });
    elements.sessionsList.append(button);
  }
}

function renderEmptyChat() {
  elements.messages.innerHTML = `<div class="empty-state"><div class="orb"><span></span></div><h2>开始一个新的开发会话</h2><p>当前会话的上下文与其他会话相互独立。</p></div>`;
}

function renderMessages(messages) {
  elements.messages.replaceChildren();
  if (!messages.length) return renderEmptyChat();
  for (const message of messages) appendMessage(message, false);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function createNewSession() {
  try {
    await api("/api/sessions", { method: "POST" });
    elements.sessionsDialog.close();
    await loadState();
    elements.input.focus();
    showToast("已新建独立会话");
  } catch (error) { showToast(error.message); }
}

function renderFileNodes(nodes, container) {
  for (const node of nodes) {
    const group = document.createElement("div");
    group.className = "tree-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-item";
    button.dataset.path = node.path;
    const icon = document.createElement("i");
    icon.textContent = node.type === "directory" ? "▸" : node.editable ? "✎" : "·";
    const label = document.createElement("span");
    label.textContent = node.name;
    button.append(icon, label);
    group.append(button);
    if (node.type === "directory") {
      const children = document.createElement("div");
      children.className = "tree-children hidden";
      renderFileNodes(node.children || [], children);
      button.addEventListener("click", () => {
        children.classList.toggle("hidden");
        icon.textContent = children.classList.contains("hidden") ? "▸" : "▾";
      });
      group.append(children);
    } else {
      button.addEventListener("click", () => openProjectFile(node.path, button));
    }
    container.append(group);
  }
}

async function loadProjectFiles(force = false) {
  if (!force && fileTreeLoadedFor === currentProject?.id) return;
  elements.fileTree.innerHTML = `<div class="file-tree-empty">正在读取项目文件…</div>`;
  try {
    const data = await api("/api/files");
    elements.fileTree.replaceChildren();
    renderFileNodes(data.files || [], elements.fileTree);
    if (!data.files?.length) elements.fileTree.innerHTML = `<div class="file-tree-empty">项目还是空的<br>可以先创建 AGENTS.md</div>`;
    fileTreeLoadedFor = currentProject?.id;
  } catch (error) {
    elements.fileTree.innerHTML = `<div class="file-tree-empty"></div>`;
    elements.fileTree.firstElementChild.textContent = error.message;
  }
}

async function openProjectFile(filePath, button = null, silent = false) {
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    selectedFile = data;
    document.querySelectorAll(".tree-item.active").forEach((item) => item.classList.remove("active"));
    button?.classList.add("active");
    elements.filePlaceholder.classList.add("hidden");
    elements.fileEditor.classList.remove("hidden");
    elements.fileEditor.value = data.content;
    elements.fileEditor.readOnly = !data.editable;
    elements.fileViewerName.textContent = data.path;
    elements.fileViewerMeta.textContent = data.editable ? "可编辑 · 保存后会在下一轮重新加载项目规范" : `只读预览 · ${formatRelativeTime(data.modifiedAt)}修改`;
    elements.saveFile.classList.toggle("hidden", !data.editable);
    return true;
  } catch (error) {
    if (!silent) showToast(error.message);
    return false;
  }
}

async function saveSelectedFile() {
  if (!selectedFile?.editable) return;
  try {
    selectedFile = await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: selectedFile.path, content: elements.fileEditor.value })
    });
    showToast("AGENTS.md 已保存");
    await loadProjectFiles(true);
  } catch (error) { showToast(error.message); }
}

function appendMessage(message, shouldScroll = true) {
  if (document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  elements.messages.querySelector(".empty-state")?.remove();
  const row = document.createElement("article");
  row.className = `message ${message.role}`;
  row.dataset.messageId = message.id;
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.content;
  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.createdAt);
  bubble.append(time);
  row.append(bubble);
  elements.messages.append(row);
  if (shouldScroll) elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: "smooth" });
}

function progressText(event) {
  const item = event.item || {};
  if (event.type === "thread.started") return "Codex 会话已连接";
  if (event.type === "turn.started") return "开始分析需求";
  if (event.type === "turn.completed") return "本轮任务已完成";
  if (event.type === "turn.failed") return `任务失败：${event.error?.message || "未知错误"}`;
  if (event.type === "error") return `错误：${event.message || event.error?.message || "未知错误"}`;
  if (event.type === "item.started") {
    if (item.type === "command_execution") return `执行命令\n${item.command || ""}`;
    if (item.type === "mcp_tool_call") return `调用工具：${item.server || ""}${item.tool ? ` / ${item.tool}` : ""}`;
    if (item.type === "web_search") return `搜索：${item.query || "正在查询"}`;
    if (item.type === "file_change") return "正在修改项目文件";
  }
  if (event.type === "item.completed") {
    if (item.type === "reasoning") return item.text ? `思考摘要\n${item.text}` : "完成一步分析";
    if (item.type === "command_execution") {
      const output = String(item.aggregated_output || item.output || "").trim();
      const result = item.exit_code === 0 ? "命令执行完成" : `命令结束，退出码 ${item.exit_code ?? "未知"}`;
      return output ? `${result}\n${output}` : result;
    }
    if (item.type === "file_change") {
      const files = (item.changes || []).map((change) => change.path || change.file).filter(Boolean);
      return files.length ? `已修改文件\n${files.join("\n")}` : "文件修改完成";
    }
    if (item.type === "mcp_tool_call") return `工具调用完成：${item.tool || item.name || ""}`;
    if (item.type === "web_search") return "搜索完成";
  }
  return "";
}

function ensureProgressBox(taskId) {
  let box = document.querySelector(`[data-progress-id="${CSS.escape(taskId)}"]`);
  if (box) return box;
  elements.messages.querySelector(".empty-state")?.remove();
  box = document.createElement("section");
  box.className = "progress-box active";
  box.dataset.progressId = taskId;
  box.innerHTML = `<button class="progress-heading" type="button"><span class="progress-spinner"></span><strong>Codex 执行过程</strong><span class="progress-count">0 条</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button><div class="progress-lines"></div>`;
  box.querySelector(".progress-heading").addEventListener("click", () => box.classList.toggle("collapsed"));
  elements.messages.append(box);
  return box;
}

function appendProgress(taskId, text, kind = "info") {
  if (!text) return;
  const box = ensureProgressBox(taskId);
  const lines = box.querySelector(".progress-lines");
  const line = document.createElement("div");
  line.className = `progress-line ${kind}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  line.innerHTML = `<time>${time}</time><pre></pre>`;
  line.querySelector("pre").textContent = text.length > 5000 ? `${text.slice(0, 5000)}\n…输出已截断` : text;
  lines.append(line);
  while (lines.children.length > 100) lines.firstElementChild.remove();
  box.querySelector(".progress-count").textContent = `${lines.children.length} 条`;
  lines.scrollTop = lines.scrollHeight;
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: "smooth" });
}

function finishProgress(taskId, status) {
  const box = document.querySelector(`[data-progress-id="${CSS.escape(taskId || "")}"]`);
  if (!box) return;
  box.classList.remove("active");
  box.classList.toggle("failed", status === "error");
  box.querySelector("strong").textContent = status === "error" ? "Codex 执行异常" : "Codex 执行过程";
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(authUrl("/api/events"));
  eventSource.addEventListener("open", () => setConnection("online", currentStatus === "running" ? "Codex 工作中" : "已连接"));
  eventSource.addEventListener("error", () => setConnection("offline", "连接中断"));
  eventSource.addEventListener("status", (event) => setStatus(JSON.parse(event.data).status));
  eventSource.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.projectId === currentProject?.id && message.sessionId === currentSession?.id) appendMessage(message);
  });
  eventSource.addEventListener("model", (event) => {
    elements.modelBadge.querySelector("span").textContent = JSON.parse(event.data).model;
  });
  eventSource.addEventListener("progress", (event) => {
    const payload = JSON.parse(event.data);
    appendProgress(payload.taskId, progressText(payload.event), payload.event.type.includes("failed") || payload.event.type === "error" ? "error" : "info");
  });
  eventSource.addEventListener("log", (event) => {
    const payload = JSON.parse(event.data);
    appendProgress(payload.taskId, String(payload.text || "").trim(), "output");
  });
  eventSource.addEventListener("task-complete", () => {
    elements.preview.src = authUrl(`/preview/?refresh=${Date.now()}`);
    showToast("开发完成，预览已更新");
  });
  eventSource.addEventListener("status", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.status !== "running") finishProgress(payload.taskId, payload.status);
  });
  eventSource.addEventListener("context-changed", () => loadState());
}

async function loadState() {
  try {
    const state = await api("/api/state");
    currentProject = state.project;
    currentSession = state.session;
    availableProjects = state.projects || [];
    availableSessions = state.sessions || [];
    renderMessages(state.messages || []);
    renderProjects();
    renderSessions();
    elements.projectPath.textContent = state.projectDir;
    elements.filesProjectPath.textContent = state.projectDir;
    $("#projectsRootHint").textContent = `相对路径会创建在 ${state.projectsRoot}`;
    elements.projectButtonName.textContent = currentProject?.name || "项目";
    elements.sessionTitle.textContent = currentSession?.title === "新会话" ? "今天想做点什么？" : currentSession?.title || "今天想做点什么？";
    elements.chatSubtitle.textContent = `${currentProject?.name || "当前项目"} · ${availableSessions.length} 个会话`;
    elements.modelBadge.querySelector("span").textContent = state.model || "默认模型";
    setStatus(state.status);
    elements.preview.src = authUrl(state.previewUrl);
    selectedFile = null;
    fileTreeLoadedFor = null;
    elements.fileEditor.classList.add("hidden");
    elements.filePlaceholder.classList.remove("hidden");
    elements.saveFile.classList.add("hidden");
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) connectEvents();
  } catch (error) {
    setConnection("offline", "未连接");
    if (error.message.includes("令牌") || error.message.includes("401")) elements.dialog.showModal();
    else showToast(error.message);
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 140)}px`;
}

async function submitPrompt(prompt) {
  const value = prompt.trim();
  if (!value || currentStatus === "running") return;
  elements.input.value = "";
  resizeInput();
  try {
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ prompt: value }) });
  } catch (error) {
    elements.input.value = value;
    resizeInput();
    showToast(error.message);
  }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt(elements.input.value);
});
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitPrompt(elements.input.value);
});
elements.stop.addEventListener("click", async () => {
  try { await api("/api/stop", { method: "POST" }); } catch (error) { showToast(error.message); }
});

document.querySelectorAll(".suggestions button").forEach((button) => {
  button.addEventListener("click", () => {
    elements.input.value = button.textContent.trim();
    resizeInput();
    elements.input.focus();
  });
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .panel").forEach((element) => element.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
    if (tab.dataset.panel === "previewPanel") elements.preview.contentWindow?.location.reload();
    if (tab.dataset.panel === "filesPanel") loadProjectFiles();
  });
});

$("#refreshButton").addEventListener("click", () => {
  elements.preview.src = authUrl(`/preview/?refresh=${Date.now()}`);
});
$("#openButton").addEventListener("click", () => window.open(authUrl("/preview/"), "_blank", "noopener"));
$("#settingsButton").addEventListener("click", () => {
  elements.tokenInput.value = token;
  elements.dialog.showModal();
});
$("#saveSettingsButton").addEventListener("click", (event) => {
  event.preventDefault();
  token = elements.tokenInput.value.trim();
  localStorage.setItem(tokenKey, token);
  elements.dialog.close();
  connectEvents();
  loadState();
});
elements.projectButton.addEventListener("click", () => {
  renderProjects();
  elements.projectsDialog.showModal();
});
$("#editProjectPreviewButton").addEventListener("click", () => {
  if (!currentProject) return;
  elements.projectsDialog.close();
  $("#previewProjectName").textContent = `${currentProject.name} · ${currentProject.path}`;
  $("#editPreviewInput").value = editablePreviewValue(currentProject.previewUrl);
  elements.projectPreviewDialog.showModal();
  $("#editPreviewInput").focus();
});
$("#projectPreviewForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/projects/update-preview", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProject.id, previewUrl: $("#editPreviewInput").value.trim() })
    });
    elements.projectPreviewDialog.close();
    await loadState();
    showToast(`预览地址已更新为 ${result.project.previewUrl}`);
  } catch (error) { showToast(error.message); }
});
$("#sessionsButton").addEventListener("click", () => {
  renderSessions();
  elements.sessionsDialog.showModal();
});
$("#newSessionButton").addEventListener("click", createNewSession);
$("#dialogNewSessionButton").addEventListener("click", createNewSession);
document.querySelectorAll(".dialog-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
$("#createProjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("#projectNameInput").value.trim(),
        path: $("#projectPathInput").value.trim(),
        previewUrl: $("#projectPreviewInput").value.trim()
      })
    });
    form.reset();
    $("#projectPreviewInput").value = "3000";
    elements.projectsDialog.close();
    await loadState();
    showToast(`项目 ${result.project.name} 已就绪`);
  } catch (error) { showToast(error.message); }
});
$("#filesRefreshButton").addEventListener("click", () => loadProjectFiles(true));
$("#saveFileButton").addEventListener("click", saveSelectedFile);
$("#createAgentsButton").addEventListener("click", async () => {
  if (await openProjectFile("AGENTS.md", null, true)) return;
  selectedFile = { path: "AGENTS.md", content: "# 项目开发约定\n\n", editable: true };
  elements.filePlaceholder.classList.add("hidden");
  elements.fileEditor.classList.remove("hidden");
  elements.fileEditor.readOnly = false;
  elements.fileEditor.value = selectedFile.content;
  elements.fileViewerName.textContent = "AGENTS.md";
  elements.fileViewerMeta.textContent = "新文件 · 保存后 Codex 会自动读取";
  elements.saveFile.classList.remove("hidden");
});

loadState();
