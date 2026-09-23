// ─────────────────────────────────────────────────────────────
// dsh-console · Host 半
// 主视图「控制台」标签页的后端：每个标签 = 一个真 PTY 会话
// （ctx.subprocess.spawnTerminal，node-pty 底层，用户登录 shell + 完整 env）。
//   · RPC 路由 /plugins/dsh-console/rpc：
//       tab.list / tab.open(cwd?) / tab.close(id) / tab.write(id, data)
//   · SSE 路由 /plugins/dsh-console/stream?tab=<id>：
//       连接即回放 ring buffer，随后实时转发 PTY 输出；会话退出发 exit 事件。
// 标签注册表进程内存态：PTY 会话不跨 DSH 重启（与 iTerm 关窗一致）。
// ─────────────────────────────────────────────────────────────
/** 回放上限：512KB —— 足够还原最近几十屏，防内存无限增长 */
const MAX_BUFFER_BYTES = 512 * 1024;
/** 终端几何（v1 固定；resize 需 DSH subprocess seam 补丁，见 README） */
const TERM_COLS = 120;
const TERM_ROWS = 34;
/** TERM→KILL 清理宽限 */
const GRACE_MS = 3000;
const tabs = new Map();
let tabSeq = 0;
function newTabId() {
    tabSeq += 1;
    return `t${Date.now().toString(36)}-${tabSeq}`;
}
function userShell() {
    return process.env.SHELL || '/bin/zsh';
}
// ── 标签操作 ────────────────────────────────────────────────
async function openTab(ctx, cwd) {
    const subprocess = ctx.get('subprocess');
    if (!subprocess)
        throw new Error('subprocess service unavailable');
    const shell = userShell();
    const handle = await subprocess.spawnTerminal({
        argv: [shell, '-l'],
        cwd: cwd && cwd.trim() !== '' ? cwd : process.cwd(),
        // seam 默认净化环境；终端要用户真实 shell 体验 → 显式透传完整 env
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        rows: TERM_ROWS,
        cols: TERM_COLS,
        graceMs: GRACE_MS,
    });
    const tab = {
        id: newTabId(),
        title: `终端 ${tabSeq + 1}`,
        pid: handle.pid,
        createdAt: Date.now(),
        exited: false,
        handle,
        buffer: [],
        bufferedBytes: 0,
        subscribers: new Set(),
        exitListeners: new Set(),
    };
    tabs.set(tab.id, tab);
    // host 侧常驻泵：从 spawn 起持续消费输出进 ring buffer（防无订阅者时流积压），
    // 并转发给所有 SSE 订阅者。注意 chunk 可能是 Buffer，统一转 UTF-8 字符串。
    handle.output.on('data', (raw) => {
        const chunk = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
        tab.buffer.push(chunk);
        tab.bufferedBytes += chunk.length;
        while (tab.bufferedBytes > MAX_BUFFER_BYTES && tab.buffer.length > 1) {
            tab.bufferedBytes -= tab.buffer[0].length;
            tab.buffer.shift();
        }
        for (const send of tab.subscribers) {
            try {
                send(chunk);
            }
            catch { /* 订阅者自行清理 */ }
        }
    });
    handle.done.then((outcome) => {
        tab.exited = true;
        for (const notify of tab.exitListeners) {
            try {
                notify(outcome);
            }
            catch { /* ignore */ }
        }
    }).catch(() => {
        tab.exited = true;
        for (const notify of tab.exitListeners) {
            try {
                notify({ exitCode: null, signal: null });
            }
            catch { /* ignore */ }
        }
    });
    return tab;
}
async function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab)
        return false;
    tabs.delete(id);
    tab.subscribers.clear();
    tab.exitListeners.clear();
    try {
        await tab.handle.terminate();
    }
    catch { /* 已退出 */ }
    return true;
}
function tabSummary(tab) {
    return { id: tab.id, title: tab.title, pid: tab.pid, createdAt: tab.createdAt, exited: tab.exited };
}
// ── RPC + SSE 路由 ───────────────────────────────────────────
const rpcHandlers = new Map();
let routesRegistered = false;
function registerRoutes(ctx) {
    if (routesRegistered)
        return;
    const webServer = ctx.get('webServer') ?? ctx.get('httpServer');
    if (!webServer)
        return;
    routesRegistered = true;
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-console/rpc',
        handler: async (req, res) => {
            let body = '';
            for await (const chunk of req)
                body += chunk;
            let payload = {};
            try {
                payload = JSON.parse(body || '{}');
            }
            catch { /* ignore */ }
            const fn = rpcHandlers.get(payload.method);
            if (!fn) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'method-not-found' }));
                return;
            }
            try {
                const value = await fn(payload.args ?? null, ctx);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(value ?? null));
            }
            catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
            }
        },
    }), 'dsh-console: rpc route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-console/stream',
        handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const tabId = url.searchParams.get('tab') ?? '';
            const tab = tabs.get(tabId);
            if (!tab) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'tab-not-found' }));
                return;
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
            });
            res.write(':connected\n\n');
            // 回放 ring buffer（切标签回来 / 页面刷新后还原画面）
            if (tab.buffer.length > 0) {
                res.write(`data: ${JSON.stringify(tab.buffer.join(''))}\n\n`);
            }
            const send = (chunk) => { res.write(`data: ${JSON.stringify(chunk)}\n\n`); };
            const onExit = (outcome) => {
                res.write(`event: exit\ndata: ${JSON.stringify(outcome)}\n\n`);
                try {
                    res.end();
                }
                catch { /* ignore */ }
            };
            tab.subscribers.add(send);
            tab.exitListeners.add(onExit);
            // 心跳：防中间层掐空闲连接
            const heartbeat = setInterval(() => {
                try {
                    res.write(':hb\n\n');
                }
                catch { /* ignore */ }
            }, 15000);
            const cleanup = () => {
                clearInterval(heartbeat);
                tab.subscribers.delete(send);
                tab.exitListeners.delete(onExit);
                try {
                    res.end();
                }
                catch { /* ignore */ }
            };
            req.on('close', cleanup);
            if (tab.exited)
                onExit({ exitCode: null, signal: null });
        },
    }), 'dsh-console: stream route');
}
// ── 插件入口 ─────────────────────────────────────────────────
export const name = 'dsh-console';
export const inject = ['subprocess'];
export function apply(ctx) {
    rpcHandlers.set('tab.list', async () => [...tabs.values()].map(tabSummary));
    rpcHandlers.set('tab.open', async (args) => {
        const tab = await openTab(ctx, args?.cwd);
        return tabSummary(tab);
    });
    rpcHandlers.set('tab.close', async (args) => {
        if (!args?.id)
            throw new Error('id required');
        const ok = await closeTab(args.id);
        if (!ok)
            throw new Error('tab not found');
        return true;
    });
    rpcHandlers.set('tab.write', async (args) => {
        const tab = tabs.get(args?.id);
        if (!tab)
            throw new Error('tab not found');
        await tab.handle.write(String(args.data ?? ''));
        return true;
    });
    registerRoutes(ctx);
    ctx.on('internal/service', (name) => {
        if (name === 'webServer' || name === 'httpServer')
            registerRoutes(ctx);
    });
    // 插件卸载 / DSH 退出：终止全部 PTY 会话
    ctx.effect(() => () => {
        for (const id of [...tabs.keys()])
            void closeTab(id);
    });
}
