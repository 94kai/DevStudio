const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = __dirname;
const envFile = join(projectRoot, ".env");

// 读取项目环境变量，已由启动环境显式设置的值优先。
function loadProjectEnv() {
  if (!existsSync(envFile)) return {};

  return Object.fromEntries(readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separatorIndex = line.indexOf("=");
      const key = line.slice(0, separatorIndex).trim().replace(/^export\s+/, "");
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
      return [key, process.env[key] ?? value];
    })
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)));
}

module.exports = {
  apps: [{
    name: "devstudio",
    cwd: projectRoot,
    script: "server.mjs",
    interpreter: "node",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    restart_delay: 3000,
    max_memory_restart: "1G",
    time: true,
    env: loadProjectEnv()
  }]
};
