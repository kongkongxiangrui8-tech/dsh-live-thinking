'use strict';
/**
 * dsh-live-thinking — 宿主半边：空实现。
 *
 * 状态链路由浏览器直接推给桌面小窗（127.0.0.1 上的 loopback HTTP），小窗由
 * 登录启动项管理；宿主侧不需要参与，所以这里只保留 loader 要求的可解析入口。
 */
const NAME = 'dsh-live-thinking';

function apply() {
	// 纯客户端插件 + 独立小窗进程，宿主侧无事可做。
}

module.exports = { name: NAME, apply };
