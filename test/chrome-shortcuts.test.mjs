import test from "node:test";
import assert from "node:assert/strict";
import { hasDebugFlag, mergeChromeArgs, splitArgs } from "../chrome-shortcuts.js";
import { mergeCommandLine, splitCommandLine } from "../chrome-shortcuts.js";

const PROFILE = "C:\\Users\\user\\AppData\\Local\\ChromeDebugUserData";

test("splitArgs 保留引号内空格，空串返回空数组", () => {
  assert.deepEqual(splitArgs('--user-data-dir="C:\\a b\\c" --no-first-run'), [
    '--user-data-dir="C:\\a b\\c"',
    "--no-first-run"
  ]);
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test("hasDebugFlag 能识别新旧两种写法，不误判相似参数", () => {
  assert.equal(hasDebugFlag("--remote-debugging-port=9222"), true);
  assert.equal(hasDebugFlag("--no-first-run --remote-debugging-port=9223"), true);
  assert.equal(hasDebugFlag("--remote-debugging-port 9222"), true);
  assert.equal(hasDebugFlag("--no-first-run"), false);
  assert.equal(hasDebugFlag(""), false);
});

test("mergeChromeArgs 替换默认目录、补齐端口，保留用户其它参数", () => {
  const merged = mergeChromeArgs(
    '--user-data-dir="C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data" --no-first-run',
    PROFILE
  );
  assert.equal(
    merged,
    `--no-first-run --user-data-dir="${PROFILE}" --remote-debugging-port=9222`
  );
});

test("mergeChromeArgs 幂等：已有端口与 profile 时结果不变", () => {
  const once = mergeChromeArgs("--no-first-run", PROFILE);
  const twice = mergeChromeArgs(once, PROFILE);
  assert.equal(twice, once);
});

test("mergeChromeArgs 对空参数只追加两项", () => {
  assert.equal(
    mergeChromeArgs("", PROFILE, "9333"),
    `--user-data-dir="${PROFILE}" --remote-debugging-port=9333`
  );
});

test("splitCommandLine 拆分带引号 exe 与参数，兼容无引号", () => {
  assert.deepEqual(
    splitCommandLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-startup-window /prefetch:5'),
    { exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: "--no-startup-window /prefetch:5" }
  );
  assert.deepEqual(splitCommandLine("chrome.exe"), { exe: "chrome.exe", args: "" });
  assert.deepEqual(splitCommandLine("chrome.exe --no-first-run"), {
    exe: "chrome.exe",
    args: "--no-first-run"
  });
});

test("mergeCommandLine 保留开机自启参数并补齐端口与 profile", () => {
  const merged = mergeCommandLine(
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-startup-window /prefetch:5',
    PROFILE
  );
  assert.equal(
    merged,
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-startup-window /prefetch:5 --user-data-dir="${PROFILE}" --remote-debugging-port=9222`
  );
});
