'use strict';
/**
 * dsh-live-thinking — 宿主半边：负责在 DSH 启动时把桌面小窗拉起来。
 *
 * 状态链路：浏览器插件把状态 POST 到 127.0.0.1:17863，overlay.ps1 在该端口监听
 * 并绘制悬浮窗。窗口是独立进程，之前靠「登录启动项」管理；启动项被删掉后，
 * DSH 工作期间就没有窗口可显示状态了，所以改成由宿主在启动时确保它在跑：
 *   - 先探测 17863 端口，已经有人监听就直接返回，不重复启动；
 *   - 没在跑就静默拉起同目录的 start-overlay.vbs（wscript，无控制台窗口）。
 * overlay.ps1 自身还有单实例互斥锁，即使并发启动也只会留下一个实例。
 */
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const net = require('node:net');
const { join } = require('node:path');

/** 插件名。 */
const NAME = 'dsh-live-thinking';
/** 悬浮窗监听端口，与 overlay.ps1 的默认值保持一致。 */
const OVERLAY_PORT = 17863;
/** 悬浮窗监听地址。 */
const OVERLAY_HOST = '127.0.0.1';
/** 插件目录被挪走时的兜底启动器路径。 */
const FALLBACK_LAUNCHER = 'C:\\Users\\lenovo\\Desktop\\DSH live thinking 悬浮窗\\start-overlay.vbs';

/**
 * 找启动器：优先用与本文件同目录的 start-overlay.vbs。
 * @returns {string} 启动器绝对路径；找不到时为空串。
 */
function launcherPath() {
  const local = join(__dirname, 'start-overlay.vbs');
  if (existsSync(local)) return local;
  if (existsSync(FALLBACK_LAUNCHER)) return FALLBACK_LAUNCHER;
  return '';
}

/**
 * 静默拉起悬浮窗。失败只当增强项不可用，绝不影响 DSH 启动。
 * @param {string} launcher - start-overlay.vbs 的路径。
 */
function spawnOverlay(launcher) {
  try {
    const child = spawn('wscript.exe', [launcher], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 悬浮窗是增强项，宿主不因它失败。
  }
}

/**
 * 端口没人监听时启动悬浮窗。
 */
function ensureOverlay() {
  const launcher = launcherPath();
  if (launcher === '') return;

  let settled = false;
  const finish = (running) => {
    if (settled) return;
    settled = true;
    if (!running) spawnOverlay(launcher);
  };

  try {
    const socket = net.connect({ host: OVERLAY_HOST, port: OVERLAY_PORT });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      finish(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish(false);
    });
    socket.once('error', () => finish(false));
  } catch {
    finish(false);
  }
}

/**
 * 宿主启动时执行一次。
 */
function apply() {
  try {
    ensureOverlay();
  } catch {
    // 同上：增强项失败不影响宿主。
  }
}

module.exports = { name: NAME, apply };
