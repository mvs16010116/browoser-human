/**
 * Chrome 启动快捷方式迁移。
 *
 * 背景：`--remote-debugging-port` 只在 Chrome 启动那一刻生效，且 Chrome 136+
 * 会静默忽略指向默认 profile 目录的该参数。用户从原快捷方式启动的 Chrome 因此
 * 永远不可附着，只能每次让用户关浏览器——体验不可接受。
 *
 * 方案：把桌面 / 开始菜单 / 任务栏里的 chrome.exe 快捷方式改造成
 * `--user-data-dir=<联接 profile> --remote-debugging-port=<port>`（原快捷方式备份为 .bak）。
 * 此后用户照旧点原图标启动，Chrome 天生带调试端口，MCP 可随时附着，无需再关浏览器。
 *
 * 分层：参数拼装（纯函数，可单测）留在 Node；PowerShell 只做 .lnk 的读写 I/O。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = "9222";
const FLAG_PORT = "--remote-debugging-port";
const FLAG_PROFILE = "--user-data-dir";
const BACKUP_SUFFIX = ".bak";

/** 按双引号切分命令行参数，保留引号内的空格。 */
export function splitArgs(raw) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const ch of raw || "") {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** 快捷方式参数里是否已带调试端口。 */
export function hasDebugFlag(args) {
  return splitArgs(args).some((token) => token.startsWith(FLAG_PORT));
}

/**
 * 把现有参数改造成「联接 profile + 调试端口」，其余用户参数原样保留。
 * 纯函数：同样的输入必得同样的输出，便于单测与幂等重跑。
 */
export function mergeChromeArgs(existing, debugProfile, port = DEFAULT_PORT) {
  const kept = splitArgs(existing).filter(
    (token) => !token.startsWith(FLAG_PORT) && !token.startsWith(FLAG_PROFILE)
  );
  kept.push(`${FLAG_PROFILE}="${debugProfile}"`, `${FLAG_PORT}=${port}`);
  return kept.join(" ");
}

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:PUBLIC 'Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$shell = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($dir in $dirs) {
  Get-ChildItem $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $shell.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -like '*\\chrome.exe') {
      $rows += [pscustomobject]@{ file = $_.FullName; args = $lnk.Arguments }
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`;

const APPLY_SCRIPT = `
param([string]$PayloadPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
$items = Get-Content $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$results = @()
foreach ($item in @($items)) {
  try {
    $backup = $item.file + '${BACKUP_SUFFIX}'
    if (-not (Test-Path $backup)) { Copy-Item $item.file $backup -Force }
    $lnk = $shell.CreateShortcut($item.file)
    $lnk.Arguments = $item.args
    $lnk.Save()
    $results += [pscustomobject]@{ file = $item.file; ok = $true }
  } catch {
    $results += [pscustomobject]@{ file = $item.file; ok = $false; error = $_.Exception.Message }
  }
}
$json = ConvertTo-Json -InputObject @($results) -Compress -Depth 3
[System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
$json
`;

// 系统级目录（公共桌面 / ProgramData 开始菜单）普通权限写不进去，
// 用 UAC 提权再跑一次 APPLY_SCRIPT；提权进程的 stdout 抓不到，靠 ResultPath 回传。
const ELEVATE_SCRIPT = `
param([string]$ScriptPath, [string]$PayloadPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath 'powershell' -Verb RunAs -Wait -PassThru -ArgumentList @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', $ScriptPath, '-PayloadPath', $PayloadPath, '-ResultPath', $ResultPath
)
exit $p.ExitCode
`;

/**
 * 列出所有指向 chrome.exe 的快捷方式（迁移前自检/报告用）。
 * @returns {Promise<Array<{file: string, args: string}>>}
 */
export async function listChromeShortcuts() {
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** 批量写回快捷方式参数；写前统一备份，单条失败不中断（如系统级目录需要管理员）。 */
async function applyShortcutArgs(entries, { elevate = false } = {}) {
  const stamp = `${process.pid}-${Date.now()}`;
  const dir = os.tmpdir();
  const payloadFile = path.join(dir, `browser-human-lnk-${stamp}.json`);
  const resultFile = path.join(dir, `browser-human-lnk-${stamp}.result.json`);
  const scriptFile = path.join(dir, `browser-human-lnk-${stamp}.ps1`);
  const wrapperFile = path.join(dir, `browser-human-lnk-${stamp}.elevate.ps1`);
  await fs.writeFile(payloadFile, JSON.stringify(entries), "utf8");
  await fs.writeFile(scriptFile, APPLY_SCRIPT, "utf8");
  try {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
    if (elevate) {
      await fs.writeFile(wrapperFile, ELEVATE_SCRIPT, "utf8");
      args.push("-File", wrapperFile,
        "-ScriptPath", scriptFile, "-PayloadPath", payloadFile, "-ResultPath", resultFile);
    } else {
      args.push("-File", scriptFile, "-PayloadPath", payloadFile, "-ResultPath", resultFile);
    }
    try {
      await execFileAsync("powershell", args, { maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      if (elevate && /cancel/i.test(error.message || "")) {
        throw new Error("用户取消了一次性迁移所需的管理员授权（UAC 弹窗）");
      }
      throw error;
    }
    const text = (await fs.readFile(resultFile, "utf8")).trim();
    if (!text) {
      return [];
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    await Promise.all(
      [payloadFile, resultFile, scriptFile, wrapperFile].map((file) => fs.rm(file, { force: true }))
    );
  }
}

/** 是否为权限不足导致的写入失败（系统级目录需要提权）。 */
function isAccessDenied(row) {
  return /access|denied|拒绝访问/i.test(row.error || "");
}

/**
 * 迁移全部 Chrome 快捷方式。
 * 只跳过「既带端口、profile 又已指向联接路径」的快捷方式；
 * 像「有端口但 profile 仍是默认目录」这种假阳性（Chrome 会忽略端口）必须改造。
 * 系统级目录写入失败时自动申请一次 UAC 提权重试（会弹授权框）。
 * @param {{debugProfile: string, port?: string, elevate?: boolean}} options
 * @returns {Promise<{total: number, patched: string[], skipped: string[], failed: Array<{file: string, error: string}>, elevated: boolean}>}
 */
export async function patchChromeShortcuts({ debugProfile, port = DEFAULT_PORT, elevate = true }) {
  if (process.platform !== "win32") {
    throw new Error("快捷方式迁移仅支持 Windows");
  }
  const shortcuts = await listChromeShortcuts();
  const pending = [];
  const skipped = [];
  for (const item of shortcuts) {
    const args = item.args || "";
    if (isMigrated(args, debugProfile)) {
      skipped.push(item.file);
      continue;
    }
    pending.push({ file: item.file, args: mergeChromeArgs(args, debugProfile, port) });
  }

  let applied = pending.length > 0 ? await applyShortcutArgs(pending) : [];
  let elevated = false;
  const denied = applied.filter((row) => !row.ok && isAccessDenied(row));
  if (elevate && denied.length > 0) {
    const retry = denied.map((row) => ({
      file: row.file,
      args: pending.find((item) => item.file === row.file).args
    }));
    const retried = await applyShortcutArgs(retry, { elevate: true });
    elevated = retried.some((row) => row.ok);
    applied = applied.map((row) => retried.find((next) => next.file === row.file) || row);
  }

  return {
    total: shortcuts.length,
    patched: applied.filter((row) => row.ok).map((row) => row.file),
    skipped,
    failed: applied
      .filter((row) => !row.ok)
      .map((row) => ({ file: row.file, error: row.error })),
    elevated
  };
}

/** 快捷方式是否已完成迁移：带端口且 profile 已指向联接路径。 */
export function isMigrated(args, debugProfile) {
  if (!hasDebugFlag(args)) {
    return false;
  }
  const target = debugProfile.toLowerCase();
  return splitArgs(args).some(
    (token) => token.startsWith(FLAG_PROFILE) && token.toLowerCase().includes(target)
  );
}

/* -------------------------- 开机自启（Run 键） -------------------------- */

const AUTOLAUNCH_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOLAUNCH_NAME_PREFIX = "GoogleChromeAutoLaunch";

const AUTOLAUNCH_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$row = Get-ItemProperty '${AUTOLAUNCH_RUN_KEY}'
@($row.PSObject.Properties |
  Where-Object { $_.Name -like '${AUTOLAUNCH_NAME_PREFIX}*' -and $_.Value -is [string] } |
  ForEach-Object { [pscustomobject]@{ name = $_.Name; value = $_.Value } }) |
  ConvertTo-Json -Compress -Depth 3
`;

const AUTOLAUNCH_PATCH = `
param([string]$PayloadPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
$items = Get-Content $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($item in @($items)) {
  try {
    Set-ItemProperty -Path '${AUTOLAUNCH_RUN_KEY}' -Name $item.name -Value $item.value
    $results += [pscustomobject]@{ name = $item.name; ok = $true }
  } catch {
    $results += [pscustomobject]@{ name = $item.name; ok = $false; error = $_.Exception.Message }
  }
}
$json = ConvertTo-Json -InputObject @($results) -Compress -Depth 3
[System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
$json
`;

/** 拆分「带引号的 exe + 参数」命令行。 */
export function splitCommandLine(value) {
  const text = (value || "").trim();
  const quoted = /^"([^"]+)"\s*([\s\S]*)$/.exec(text);
  if (quoted) {
    return { exe: quoted[1], args: quoted[2] };
  }
  const firstSpace = text.search(/\s/);
  return firstSpace === -1
    ? { exe: text, args: "" }
    : { exe: text.slice(0, firstSpace), args: text.slice(firstSpace + 1) };
}

/** 把注册表启动项的命令行改造成「联接 profile + 调试端口」，其余参数保留。 */
export function mergeCommandLine(value, debugProfile, port = DEFAULT_PORT) {
  const { exe, args } = splitCommandLine(value);
  return `"${exe}" ${mergeChromeArgs(args, debugProfile, port)}`;
}

/** 列出 Chrome 的开机自启项（Chrome 自己写入的 GoogleChromeAutoLaunch*）。 */
export async function listChromeAutolaunch() {
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", AUTOLAUNCH_QUERY],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * 同步开机自启项：否则每次开机 Chrome 会先以默认 profile 无端口启动，
 * 用户再点图标就变成「已在运行但无端口」，又得关浏览器。
 * @returns {Promise<{patched: string[], skipped: string[], failed: Array<{name: string, error: string}>}>}
 */
export async function patchChromeAutolaunch({ debugProfile, port = DEFAULT_PORT }) {
  const rows = await listChromeAutolaunch();
  const pending = [];
  const skipped = [];
  for (const row of rows) {
    if (isMigrated(row.value, debugProfile)) {
      skipped.push(row.name);
      continue;
    }
    pending.push({ name: row.name, value: mergeCommandLine(row.value, debugProfile, port) });
  }
  if (pending.length === 0) {
    return { patched: [], skipped, failed: [] };
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const dir = os.tmpdir();
  const payloadFile = path.join(dir, `browser-human-run-${stamp}.json`);
  const resultFile = path.join(dir, `browser-human-run-${stamp}.result.json`);
  const scriptFile = path.join(dir, `browser-human-run-${stamp}.ps1`);
  await fs.writeFile(payloadFile, JSON.stringify(pending), "utf8");
  await fs.writeFile(scriptFile, AUTOLAUNCH_PATCH, "utf8");
  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptFile, "-PayloadPath", payloadFile, "-ResultPath", resultFile],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const text = (await fs.readFile(resultFile, "utf8")).trim();
    const parsed = text ? JSON.parse(text) : [];
    const results = Array.isArray(parsed) ? parsed : [parsed];
    return {
      patched: results.filter((row) => row.ok).map((row) => row.name),
      skipped,
      failed: results
        .filter((row) => !row.ok)
        .map((row) => ({ name: row.name, error: row.error }))
    };
  } finally {
    await Promise.all(
      [payloadFile, resultFile, scriptFile].map((file) => fs.rm(file, { force: true }))
    );
  }
}
