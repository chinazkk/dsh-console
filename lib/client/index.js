// @ts-nocheck — the plugin body below is JS-style (mirrors dsh-task-panel client form).
// ─────────────────────────────────────────────────────────────
// dsh-console · Client 半
// 主视图「控制台」标签页：iTerm 风格多标签栏 + xterm.js 真 PTY 终端。
//   · 下行：EventSource 订阅 /plugins/dsh-console/stream?tab=<id>（连接即回放）
//   · 上行：键入 → POST /plugins/dsh-console/rpc { method: 'tab.write' }
//   · 每标签一个 xterm 实例常驻（隐藏不销毁），切标签不丢画面
// ─────────────────────────────────────────────────────────────
import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { XTERM_CSS } from './xterm-css.js';
const styles = {
    insert(css) {
        const el = document.createElement('style');
        el.textContent = css;
        document.head.appendChild(el);
        return () => { el.remove(); };
    },
};
const host = {
    call: (method, args) => fetch('/plugins/dsh-console/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args: args ?? null }),
    }).then((r) => r.json()).then((d) => { if (d && d.error !== undefined)
        throw new Error(String(d.error)); return d; }),
};
// ── iTerm 风格主题（Dark Modern 近似） ──────────────────────
const ITERM_THEME = {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#3d3d3d',
    black: '#2e2e2e', red: '#ff5f5f', green: '#5fd75f', yellow: '#ffd75f',
    blue: '#5f87ff', magenta: '#d75fff', cyan: '#5fd7ff', white: '#ffffff',
    brightBlack: '#5f5f5f', brightRed: '#ff8787', brightGreen: '#87ff87', brightYellow: '#ffff87',
    brightBlue: '#87afff', brightMagenta: '#ff87ff', brightCyan: '#87ffff', brightWhite: '#ffffff',
};
const TERM_COLS = 120;
const TERM_ROWS = 34;
// ── 终端实例注册表（组件外常驻，跨面板挂载/卸载复用） ────────
// key = tabId, value = { term, es, div }
const termRegistry = new Map();
let styleCleanup = null;
function ensureTerminal(tabId) {
    let entry = termRegistry.get(tabId);
    if (entry)
        return entry;
    const term = new Terminal({
        cols: TERM_COLS,
        rows: TERM_ROWS,
        theme: ITERM_THEME,
        fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
    });
    const div = document.createElement('div');
    div.className = 'dsc-term-wrap';
    term.open(div);
    term.focus();
    const es = new EventSource(`/plugins/dsh-console/stream?tab=${encodeURIComponent(tabId)}`);
    es.onmessage = (e) => { try {
        term.write(JSON.parse(e.data));
    }
    catch { /* ignore */ } };
    es.addEventListener('exit', () => {
        term.write('\r\n\x1b[90m── 会话已退出 ──\x1b[0m\r\n');
    });
    term.onData((data) => {
        host.call('tab.write', { id: tabId, data }).catch(() => { });
    });
    entry = { term, es, div };
    termRegistry.set(tabId, entry);
    return entry;
}
function disposeTerminal(tabId) {
    const entry = termRegistry.get(tabId);
    if (!entry)
        return;
    entry.es.close();
    entry.term.dispose();
    entry.div.remove();
    termRegistry.delete(tabId);
}
// ── 控制台面板组件 ───────────────────────────────────────────
function ConsolePanel() {
    const [tabs, setTabs] = React.useState([]);
    const [activeId, setActiveId] = React.useState(null);
    const [connected, setConnected] = React.useState(true);
    const mountRef = React.useRef(null);
    const refreshTabs = React.useCallback(async () => {
        try {
            const list = await host.call('tab.list');
            setTabs(list);
            setActiveId((cur) => (list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)));
            setConnected(true);
        }
        catch {
            setConnected(false);
        }
    }, []);
    React.useEffect(() => {
        styleCleanup = styleCleanup ?? styles.insert(CSS + XTERM_CSS);
        void refreshTabs();
        return () => { };
    }, [refreshTabs]);
    // 激活标签：把对应终端 DOM 挂到容器
    React.useEffect(() => {
        const mount = mountRef.current;
        if (!mount || !activeId)
            return;
        for (const [id, entry] of termRegistry) {
            if (entry.div.parentNode === mount && id !== activeId)
                mount.removeChild(entry.div);
        }
        const entry = ensureTerminal(activeId);
        if (entry.div.parentNode !== mount)
            mount.appendChild(entry.div);
        entry.term.focus();
    }, [activeId, tabs]);
    const openTab = async () => {
        try {
            const tab = await host.call('tab.open', {});
            setTabs((cur) => [...cur, tab]);
            setActiveId(tab.id);
        }
        catch (e) {
            window.alert(`新建终端失败：${String(e && e.message ? e.message : e)}`);
        }
    };
    const closeTab = async (id) => {
        disposeTerminal(id);
        setTabs((cur) => cur.filter((t) => t.id !== id));
        try {
            await host.call('tab.close', { id });
        }
        catch { /* 已不在 */ }
    };
    const clearActive = () => {
        const entry = activeId && termRegistry.get(activeId);
        if (entry)
            entry.term.clear();
    };
    const activeTab = tabs.find((t) => t.id === activeId);
    return h$('div', { className: 'dsc-root' }, 
    // ── 标签栏 ──
    h$('div', { className: 'dsc-tabbar' }, tabs.map((t) => h$('div', {
        key: t.id,
        className: 'dsc-tab' + (t.id === activeId ? ' dsc-tab-active' : '') + (t.exited ? ' dsc-tab-dead' : ''),
        onClick: () => setActiveId(t.id),
    }, h$('span', { className: 'dsc-tab-dot' + (t.exited ? ' dsc-dot-dead' : '') }), h$('span', { className: 'dsc-tab-title' }, t.title), h$('span', {
        className: 'dsc-tab-close',
        title: '关闭',
        onClick: (e) => { e.stopPropagation(); void closeTab(t.id); },
    }, '×'))), h$('button', { className: 'dsc-newtab', title: '新建终端', onClick: openTab }, '+'), h$('div', { className: 'dsc-tabbar-spacer' }), connected ? null : h$('span', { className: 'dsc-offline' }, '⚠ 服务断开'), h$('button', { className: 'dsc-clear', title: '清屏', onClick: clearActive }, '清屏')), 
    // ── 终端区 ──
    h$('div', { className: 'dsc-body' }, activeId
        ? h$('div', { className: 'dsc-mount', ref: mountRef })
        : h$('div', { className: 'dsc-empty' }, h$('div', { className: 'dsc-empty-icon' }, '>_'), h$('div', { className: 'dsc-empty-text' }, '暂无终端'), h$('button', { className: 'dsc-empty-btn', onClick: openTab }, '新建终端'))), 
    // ── 状态栏 ──
    h$('div', { className: 'dsc-status' }, activeTab
        ? h$('span', null, `${activeTab.title} · pid ${activeTab.pid} · ${TERM_COLS}×${TERM_ROWS}` + (activeTab.exited ? ' · 已退出' : ''))
        : h$('span', null, `${TERM_COLS}×${TERM_ROWS}`)));
}
// 局部 h 帮手（React.createElement）
function h$(type, props, ...children) {
    return React.createElement(type, props ?? {}, ...children);
}
// ── 样式（主题令牌 + iTerm 深色终端区） ─────────────────────
const CSS = `
.dsc-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-1, #141414); }
.dsc-tabbar { display: flex; align-items: center; gap: 4px; padding: 6px 10px 0; background: #1a1a1a; border-bottom: 1px solid #000; flex: none; overflow-x: auto; }
.dsc-tab { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 7px 7px 0 0; cursor: pointer; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; white-space: nowrap; user-select: none; border: 1px solid transparent; border-bottom: none; background: transparent; transition: background .12s; }
.dsc-tab:hover { background: #242424; }
.dsc-tab-active { background: #2b2b2b; color: #e8e8e8; border-color: #000; box-shadow: 0 1px 0 #2b2b2b; }
.dsc-tab-dead { opacity: .55; }
.dsc-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: #5fd75f; flex: none; }
.dsc-dot-dead { background: #666; }
.dsc-tab-close { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px; color: #777; font-size: 13px; line-height: 1; }
.dsc-tab-close:hover { background: #3d3d3d; color: #ff5f5f; }
.dsc-newtab { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 16px; width: 26px; height: 26px; border-radius: 6px; cursor: pointer; flex: none; }
.dsc-newtab:hover { background: #2f2f2f; color: #fff; }
.dsc-tabbar-spacer { flex: 1; }
.dsc-offline { color: #ff9f40; font-size: 11px; padding: 0 6px; }
.dsc-clear { border: 1px solid #333; background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer; flex: none; }
.dsc-clear:hover { background: #2f2f2f; color: #fff; }
.dsc-body { flex: 1; min-height: 0; overflow: auto; background: #1e1e1e; display: flex; justify-content: center; padding: 8px 0; }
.dsc-mount { flex: none; }
.dsc-term-wrap { padding: 0 12px; }
.dsc-term-wrap .xterm { cursor: text; }
.dsc-empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.dsc-empty-icon { font-size: 34px; font-weight: 200; color: #5f87ff; font-family: "SF Mono", Menlo, monospace; }
.dsc-empty-text { font-size: 13px; }
.dsc-empty-btn { border: 1px solid #3a5b3a; background: #223322; color: #5fd75f; font-size: 12px; padding: 6px 18px; border-radius: 8px; cursor: pointer; }
.dsc-empty-btn:hover { background: #2d442d; }
.dsc-status { flex: none; padding: 3px 12px; background: #1a1a1a; border-top: 1px solid #000; color: #6a6a6a; font-size: 10px; font-family: "SF Mono", Menlo, monospace; user-select: none; }
`;
// ── 插件注册 ─────────────────────────────────────────────────
const plugin = (() => {
    return {
        // 注意：只声明实际用到的服务，多余声明会让插件卡在 PENDING（标签不出现）。
        inject: [],
        apply(ctx) {
            const slots = ctx.get('slots');
            if (!slots)
                return;
            slots.inject('conversation.view', () => slots.register({ name: 'conversation.view', id: 'dsh-console', label: '控制台', order: 15 }, () => React.createElement(ConsolePanel)));
        },
    };
})();
export const name = 'dsh-console';
export const inject = ['slots', ...plugin.inject];
export function apply(ctx) {
    return plugin.apply(ctx);
}
