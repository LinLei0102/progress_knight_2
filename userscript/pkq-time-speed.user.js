// ==UserScript==
// @name         Progress Knight Quest · 时间倍速 + 未翻译扫描
// @namespace    https://github.com/LinLei0102/progress_knight_2
// @version      1.0.0
// @description  给 Progress Knight Quest 加时间倍速（1x~最大）与未翻译文本扫描/标红，方便快速推进进度检查汉化遗漏。
// @author       -
// @match        file:///*
// @match        *://localhost/*
// @match        *://127.0.0.1/*
// @match        *://*.github.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ============================================================================
 * 原理速记（源码分析结论）
 * ----------------------------------------------------------------------------
 * 1. main.js 的 gameLoop() 每 50ms（gameTickLength = 1000/updateSpeed，updateSpeed=20）
 *    调一次 update()，也就是「一帧 = 1/20 秒游戏时间」。
 * 2. 所有增长（经验/金币/天数/事件计时/冷却）都在 update() 内部按
 *    gameSpeed / updateSpeed 的系数结算，所以「多跑几次 update()」= 时间按倍率前进，
 *    公式本身一行都不用改 —— 这是最安全的加速方式。
 * 3. increaseRealtime() 用的是 1/updateSpeed 固定值（真实秒），多跑几次后
 *    游戏内计时/冷却也一起加速，这正是快进时想要的效果。
 * 4. 危险点：main.js 发现「距上次 tick 超过 10 秒」会走 calc_offline_progress()，
 *    整块 UI 被离线结算界面接管。所以本脚本用「每 50ms 实时窗口内最多占用 25ms CPU」
 *    的预算自适应限流，保证主循环不会掉队，绝不会误触发离线结算。
 * ==========================================================================*/

(function () {
    'use strict';

    if (window.__PKQ_TS_LOADED__) return;
    window.__PKQ_TS_LOADED__ = true;

    /* ------------------------------------------------------------ 0. 等待游戏 */
    const MAX_WAIT = 20000;
    const startedAt = Date.now();

    function gameReady() {
        return typeof window.update === 'function'
            && window.gameData
            && window.gameData.taskData
            && document.getElementById('mainarea');
    }

    (function wait() {
        if (gameReady()) { try { boot(); } catch (e) { console.error('[PKQ-TS] 初始化失败', e); } return; }
        if (Date.now() - startedAt > MAX_WAIT) { console.warn('[PKQ-TS] 没找到游戏对象，脚本跳过'); return; }
        setTimeout(wait, 120);
    })();

    /* ---------------------------------------------------------------- 主流程 */
    function boot() {

        /* ---------------------------------------------------------- 1. 配置 */
        const CFG_KEY = 'pkq_ts_cfg_v1';

        function readCfg() {
            try {
                const raw = localStorage.getItem(CFG_KEY);
                if (raw) return JSON.parse(raw) || {};
            } catch (e) { /* ignore */ }
            return {};
        }

        const cfg = Object.assign({ mult: 1, autoRebirth: false, autoMark: false }, readCfg());

        function saveCfg() {
            try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
        }

        /* ------------------------------------------------- 2. 加速核心（打补丁） */
        const origUpdate = window.update;

        const state = {
            mult: Math.max(1, Number(cfg.mult) || 1), // 目标倍率
            /* 实测速率：按「每秒真实执行的 tick 数」统计，避免取单帧快照导致数字乱跳 */
            ticks: 0,
            lastTicks: 0,
            lastSampleAt: 0,
            tps: 0,                                   // ticks / 秒
            effRate: 1,                               // = tps / updateSpeed
            cost: 0.3,                                // 单次 update() 耗时 EMA(ms)
            BUDGET: 20,                               // 每 50ms 窗口可占用的 CPU 上限
            WINDOW: 50,
            winStart: 0,
            winSpent: 0,
        };

        /* 游戏基准 tick 率（data.js: const updateSpeed = 20） */
        let UPS = 20;
        try { if (typeof updateSpeed === 'number') UPS = updateSpeed; } catch (e) { /* ignore */ }

        /** 记录一次真实的 tick 并执行 */
        function tick() {
            state.ticks++;
            return origUpdate();
        }

        /** 是否正在跑离线结算（此时绝不能再叠加，否则会爆炸） */
        function isOffline() {
            try { return typeof isProcessingOfflineProgress !== 'undefined' && !!isProcessingOfflineProgress; }
            catch (e) { return false; }
        }

        window.update = function patchedUpdate() {
            const gd = window.gameData;

            // 1x / 已停用 / 死亡 / 暂停 / 离线结算 —— 原样跑一次
            if (state.mult <= 1 || !gd || !gd.is_alive || gd.paused || isOffline()) {
                return tick();
            }

            const now = performance.now();
            if (now - state.winStart >= state.WINDOW) {
                state.winStart = now;
                state.winSpent = 0;
            }

            const room = state.BUDGET - state.winSpent;
            if (room <= 0.5) {           // 这个窗口的 CPU 预算用完了，本 tick 只跑基准
                return tick();
            }

            const t0 = now;
            tick();
            let done = 1;

            const est = Math.floor(room / Math.max(state.cost, 0.02));
            const cap = Math.min(state.mult - 1, Math.max(0, est - 1), 4000);

            for (let i = 0; i < cap; i++) {
                tick();
                done++;
                // 每 8 次校准一次时间，防止单次阻塞太长导致页面卡顿
                if ((i & 7) === 7 && performance.now() - t0 >= room) break;
            }

            const dt = performance.now() - t0;
            state.winSpent += dt;
            state.cost = state.cost * 0.85 + (dt / done) * 0.15;
        };

        /** 每 200ms 采样一次真实 tick 速率 */
        function sampleRate() {
            const now = performance.now();
            if (!state.lastSampleAt) { state.lastSampleAt = now; state.lastTicks = state.ticks; return; }
            const dt = now - state.lastSampleAt;
            if (dt < 80) return;
            state.tps = (state.ticks - state.lastTicks) * 1000 / dt;
            state.lastTicks = state.ticks;
            state.lastSampleAt = now;
            state.effRate = state.tps / UPS;
        }

        /* ------------------------------------------------------ 3. 面板 UI */
        const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 500, 'max'];
        const MAX_MULT = 100000;

        const host = document.createElement('div');
        host.className = 'pkq-host';
        host.setAttribute('data-i18n-skip', '');
        const shadow = host.attachShadow({ mode: 'open' });

        shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .box {
    position: fixed; right: 14px; bottom: 14px; width: 306px;
    z-index: 2147483000;
    font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #e6e8ee; background: #1b1e26;
    border: 1px solid #333a49; border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,.55);
    user-select: none; overflow: hidden;
  }
  .hd {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px; cursor: move;
    background: linear-gradient(180deg, #232838, #1b1e26);
    border-bottom: 1px solid #2c3242;
  }
  .ttl { font-weight: 600; letter-spacing: .3px; color: #ffd166; }
  .ttl small { color: #7f889c; font-weight: 400; }
  .spacer { flex: 1; }
  button { font: inherit; cursor: pointer; }
  .mini {
    width: 20px; height: 20px; line-height: 1; padding: 0;
    color: #98a3b8; background: #262c3b; border: 1px solid #333a49;
    border-radius: 5px;
  }
  .mini:hover { color: #fff; background: #333a49; }
  .bd { padding: 10px; }
  .speeds { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin-bottom: 9px; }
  .sp {
    padding: 5px 0; text-align: center; border-radius: 6px;
    color: #b9c2d4; background: #232838; border: 1px solid #303747;
    transition: .12s;
  }
  .sp:hover { background: #2c3242; color: #fff; }
  .sp.on { color: #10131a; background: #ffd166; border-color: #ffd166; font-weight: 700; }
  .stats {
    font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    color: #9aa5ba; background: #161922; border: 1px solid #262c3b;
    border-radius: 7px; padding: 7px 9px; margin-bottom: 9px;
  }
  .stats b { color: #6ee7a8; font-weight: 600; }
  .stats .warn { color: #ff8a8a; }
  .stats div { display: flex; justify-content: space-between; gap: 8px; white-space: nowrap; }
  .chk { display: flex; align-items: center; gap: 6px; color: #9aa5ba; margin: 4px 0; }
  .chk input { accent-color: #ffd166; margin: 0; }
  .sep { height: 1px; background: #2c3242; margin: 9px 0; }
  .sec { font-weight: 600; color: #cfd6e6; margin-bottom: 6px; }
  .sec span { color: #6f7889; font-weight: 400; font-size: 11px; }
  .btnrow { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
  .btn {
    flex: 1 1 44%; padding: 5px 0; text-align: center;
    color: #cbd3e2; background: #232838; border: 1px solid #303747; border-radius: 6px;
  }
  .btn:hover { background: #2c3242; color: #fff; }
  .result { color: #7f889c; font-size: 11px; margin: 6px 0 4px; }
  .result.hit { color: #ff9db0; }
  .list { list-style: none; margin: 0; padding: 0; max-height: 116px; overflow-y: auto; }
  .list li {
    padding: 3px 6px; margin-bottom: 2px; border-radius: 4px;
    background: #161922; color: #c9b6bd; font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer;
  }
  .list li:hover { background: #262c3b; color: #fff; }
  .list li em { color: #6f7889; font-style: normal; margin-left: 4px; }
  .ft { padding: 5px 10px; color: #5c6474; font-size: 10px; background: #161922; border-top: 1px solid #232838; }
  .badge {
    position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: #ffd166; color: #10131a; font-size: 16px; cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,.5);
  }
  .hidden { display: none !important; }
  .list::-webkit-scrollbar { width: 6px; }
  .list::-webkit-scrollbar-thumb { background: #333a49; border-radius: 3px; }
</style>

<div class="box" id="box">
  <div class="hd" id="hd">
    <span class="ttl">⚡ 时间倍速 <small id="tag"></small></span>
    <span class="spacer"></span>
    <button class="mini" id="btnMin" title="折叠">—</button>
    <button class="mini" id="btnHide" title="隐藏（Alt+T 唤回）">×</button>
  </div>
  <div class="bd" id="bd">
    <div class="speeds" id="speeds"></div>
    <div class="stats" id="stats"></div>
    <label class="chk"><input type="checkbox" id="chkRebirth"> 死亡后自动重生 I（连点不用管）</label>

    <div class="sep"></div>
    <div class="sec">未翻译扫描 <span>（点条目可复制）</span></div>
    <div class="btnrow">
      <button class="btn" id="btnAll">扫描全页</button>
      <button class="btn" id="btnCur">扫描当前页</button>
      <button class="btn" id="btnCopy">复制清单</button>
      <button class="btn" id="btnClr">清除</button>
    </div>
    <label class="chk"><input type="checkbox" id="chkAuto"> 持续标记当前界面</label>
    <div class="result" id="result">未发现未翻译文本</div>
    <ul class="list" id="list"></ul>
  </div>
  <div class="ft">Alt+T 显示/隐藏　Alt+↑ / ↓ 调速</div>
</div>
<div class="badge hidden" id="badge" title="打开时间倍速面板">⚡</div>
`;

        const $ = (id) => shadow.getElementById(id);
        const boxEl = $('box'), bdEl = $('bd'), badgeEl = $('badge');

        document.body.appendChild(host);

        /* -------------------------------------------------- 4. 倍率按钮 */
        const speedsEl = $('speeds');
        let speedIdx = 0;

        SPEEDS.forEach((v, i) => {
            const b = document.createElement('button');
            b.className = 'sp';
            b.textContent = v === 'max' ? '最大' : '×' + v;
            b.dataset.idx = i;
            b.addEventListener('click', () => setMult(SPEEDS[i]));
            speedsEl.appendChild(b);
        });

        function setMult(v) {
            const real = (v === 'max') ? MAX_MULT : v;
            state.mult = real;
            cfg.mult = real;
            saveCfg();
            // 同步高亮
            [...speedsEl.children].forEach((b, i) => {
                const bv = SPEEDS[i] === 'max' ? MAX_MULT : SPEEDS[i];
                b.classList.toggle('on', bv === real);
            });
            speedIdx = SPEEDS.findIndex(x => (x === 'max' ? MAX_MULT : x) === real);
            if (speedIdx < 0) speedIdx = 0;
        }

        /* -------------------------------------------------- 5. 状态栏刷新 */
        const statsEl = $('stats');
        const tagEl = $('tag');

        function num(n, digits) {
            if (!isFinite(n)) return '∞';
            return n.toFixed(digits === undefined ? 1 : digits);
        }

        function fmtDur(s) {
            if (!isFinite(s)) return '—';
            if (s < 60) return Math.round(s) + ' 秒';
            if (s < 3600) return (s / 60).toFixed(1) + ' 分';
            return (s / 3600).toFixed(1) + ' 小时';
        }

        function refreshStats() {
            sampleRate();
            const gd = window.gameData;
            if (!gd) return;

            const eff = state.effRate;
            const gs = Number(gd.game_speed) || 0;
            const daysPerSec = gs * eff;

            let lifeTxt = '—';
            try {
                const lifespan = (typeof window.getLifespan === 'function') ? window.getLifespan() : Infinity;
                if (isFinite(lifespan)) {
                    const leftDays = lifespan - gd.days;
                    if (leftDays <= 0) {
                        lifeTxt = '<span class="warn">已死亡</span>';
                    } else if (daysPerSec > 0) {
                        lifeTxt = num(leftDays / 365) + ' 年 · 约 ' + fmtDur(leftDays / daysPerSec);
                    } else {
                        lifeTxt = num(leftDays / 365) + ' 年 · <span class="warn">已暂停</span>';
                    }
                } else {
                    lifeTxt = '∞';
                }
            } catch (e) { lifeTxt = '—'; }

            statsEl.innerHTML =
                '<div><span>目标 / 实际</span><span>×' + (state.mult >= MAX_MULT ? '∞' : state.mult) +
                ' / <b>×' + num(eff) + '</b></span></div>' +
                '<div><span>每秒 tick</span><span>' + Math.round(state.tps) + ' 次 · ' + num(state.cost, 3) + ' ms/次</span></div>' +
                '<div><span>游戏内速度</span><span>' + num(gs) + ' 天/秒 → <b>' + num(daysPerSec) + '</b> 天/秒</span></div>' +
                '<div><span>距死亡</span><span>' + lifeTxt + '</span></div>' +
                '<div><span>年龄</span><span>' + num((gd.days || 0) / 365, 2) + ' 年（第 ' +
                (Number(gd.rebirthOneCount) || 0) + ' 世）</span></div>';

            tagEl.textContent = state.mult > 1 ? '×' + (state.mult >= MAX_MULT ? '∞' : state.mult) : '';

            // 自动重生
            if (cfg.autoRebirth && !gd.is_alive) {
                try {
                    if (typeof window.allowRebirth === 'function' && window.allowRebirth(1)
                        && typeof window.rebirthOne === 'function') {
                        window.rebirthOne();
                    }
                } catch (e) { /* ignore */ }
            }
        }

        setInterval(refreshStats, 200);

        /* -------------------------------------------------- 6. 未翻译扫描 */
        const MARK = 'pkq-untr';
        const MARK_LIVE = 'pkq-untr-live';

        const markStyle = document.createElement('style');
        markStyle.textContent =
            '.' + MARK + '{outline:2px solid #ff4d6d!important;outline-offset:-1px!important;' +
            'background:rgba(255,77,109,.16)!important;border-radius:2px;}' +
            '.' + MARK_LIVE + '{outline:2px dashed #ffa14d!important;outline-offset:-1px!important;' +
            'background:rgba(255,161,77,.14)!important;border-radius:2px;}';
        document.head.appendChild(markStyle);

        // 数字（含科学计数法）以及紧跟其后的 1~2 位小写单位后缀，如 1.20kp
        const NUM_RE = /\d+(?:[.,]\d+)*(?:\s?[eE][+\-−]?\d+)?(?:[a-z]{1,2}\b)?/g;
        const WORD_RE = /[A-Za-z]{2,}/g;

        // 这些词算「允许保留英文」的（单位、缩写），不算漏翻
        const ALLOW = new Set([
            'xp', 'lv', 'lvl', 'ok', 'hp', 'mp', 'id', 'ui', 'dps', 'exp', 'vs', 'max', 'min', 'sec',
            'ms', 'ns', 'dlc', 'mod', 'apk', 'os', 'pc', 'db', 'ai', 'ios', 'cpu', 'fps', 'pvp', 'npc',
            'mpp', 'epp', 'kp', 'github', 'shift', 'english'
        ]);

        function badWords(text) {
            if (!text) return null;
            const stripped = text.replace(NUM_RE, ' ').replace(/[×✕✖*∗]/g, ' ');
            const words = stripped.match(WORD_RE);
            if (!words) return null;

            const bad = [];
            for (let i = 0; i < words.length; i++) {
                const w = words[i];
                if (ALLOW.has(w.toLowerCase())) continue;
                if (/^[IVXLCDM]+$/.test(w)) continue;                 // 罗马数字
                if (/^[A-Z]{1,2}$/.test(w)) continue;                 // 1~2 个大写缩写
                bad.push(w);
            }
            return bad.length ? bad : null;
        }

        const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

        function isVisible(el) {
            if (!el) return false;
            if (el.getClientRects && el.getClientRects().length) return true;
            // 兜底：rects 拿不到时（display:contents / 非浏览器环境）按隐藏类判断
            if (el.closest && el.closest('.hidden,[hidden]')) return false;
            if (el.offsetWidth || el.offsetHeight) return true;
            try {
                const st = getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden';
            } catch (e) { return false; }
        }

        function markElement(el, cls) {
            if (!el || !el.classList) return false;
            if (el === document.body || el === document.documentElement) return false;
            el.classList.add(cls);
            return true;
        }

        function clearMarks(cls) {
            document.querySelectorAll('.' + cls).forEach(e => e.classList.remove(cls));
        }

        /**
         * 扫描文本节点
         * @param {Node} root
         * @param {boolean} visibleOnly
         * @param {string} cls
         */
        function scanText(root, visibleOnly, cls) {
            const hits = new Map();
            let count = 0;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
                const parent = node.parentElement;
                if (!parent) continue;
                const tag = parent.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
                if (parent.closest('[data-i18n-skip]')) continue;

                const raw = node.nodeValue;
                if (!raw || !/[A-Za-z]/.test(raw)) continue;

                const bad = badWords(raw);
                if (!bad) continue;

                if (visibleOnly && !isVisible(parent)) continue;
                if (!markElement(parent, cls)) continue;

                count++;
                const key = clean(raw).slice(0, 90);
                hits.set(key, (hits.get(key) || 0) + 1);
            }

            // 属性文本（tooltip / placeholder / data-short 等）
            if (root.querySelectorAll) {
                const list = root.querySelectorAll('[title],[placeholder],[alt],[data-short]');
                for (let i = 0; i < list.length; i++) {
                    const el = list[i];
                    if (el.closest('[data-i18n-skip]')) continue;
                    let val = null;
                    for (const a of ['title', 'placeholder', 'alt', 'data-short']) {
                        const v = el.getAttribute(a);
                        if (v && /[A-Za-z]/.test(v) && badWords(v)) { val = v; break; }
                    }
                    if (!val) continue;
                    if (visibleOnly && !isVisible(el)) continue;
                    if (!markElement(el, cls)) continue;
                    count++;
                    const key = clean(val).slice(0, 90);
                    hits.set(key, (hits.get(key) || 0) + 1);
                }
            }

            return { count, hits };
        }

        const resultEl = $('result');
        const listEl = $('list');
        let lastHits = new Map();     // 供「复制清单」使用

        function renderHits(hits) {
            listEl.innerHTML = '';
            lastHits = hits;
            let total = 0;
            const arr = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400);
            for (const [text, n] of arr) {
                total += n;
                const li = document.createElement('li');
                li.textContent = text;
                li.title = '点击复制：' + text;
                if (n > 1) {
                    const em = document.createElement('em');
                    em.textContent = '×' + n;
                    li.appendChild(em);
                }
                li.addEventListener('click', () => copy(text));
                listEl.appendChild(li);
            }
            return total;
        }

        function copy(text, msg) {
            const done = () => {
                resultEl.textContent = msg || ('已复制：' + String(text).replace(/\s+/g, ' ').slice(0, 40));
            };
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done, fallback);
                } else fallback();
            } catch (e) { fallback(); }

            function fallback() {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand && document.execCommand('copy');
                    document.body.removeChild(ta);
                    if (!ok) throw new Error('execCommand failed');
                    done();
                } catch (e) {
                    resultEl.textContent = '复制失败，请手动选中文本复制';
                }
            }
        }

        function runScan(root, visibleOnly, cls, label) {
            const { count, hits } = scanText(root, visibleOnly, cls);
            const total = renderHits(hits);
            resultEl.classList.toggle('hit', total > 0);
            resultEl.textContent = total > 0
                ? label + '：未翻译 ' + total + ' 处 / ' + hits.size + ' 种'
                : label + '：未发现未翻译文本';
        }

        $('btnAll').addEventListener('click', () => {
            clearMarks(MARK);
            clearMarks(MARK_LIVE);
            runScan(document.body, false, MARK, '全页扫描');
        });

        $('btnCur').addEventListener('click', () => {
            clearMarks(MARK_LIVE);
            runScan(document.body, true, MARK_LIVE, '当前界面');
        });

        $('btnClr').addEventListener('click', () => {
            clearMarks(MARK);
            clearMarks(MARK_LIVE);
            listEl.innerHTML = '';
            lastHits = new Map();
            resultEl.classList.remove('hit');
            resultEl.textContent = '已清除标记';
        });

        // 把当前清单按「原文\t次数」全部复制出去，方便贴进 zh-CN.js 补词条
        $('btnCopy').addEventListener('click', () => {
            if (!lastHits.size) { resultEl.textContent = '清单为空，先扫描一下'; return; }
            const lines = [...lastHits.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([txt, n]) => txt + '\t' + n)
                .join('\n');
            copy(lines, '已复制 ' + lastHits.size + ' 条清单');
        });

        // 持续标记：低频扫可见区域（避免影响帧率）
        setInterval(() => {
            if (!cfg.autoMark) return;
            if (document.hidden) return;
            clearMarks(MARK_LIVE);
            const { hits } = scanText(document.body, true, MARK_LIVE);
            const total = renderHits(hits);
            resultEl.classList.toggle('hit', total > 0);
            resultEl.textContent = total > 0
                ? '实时标记：' + total + ' 处 / ' + hits.size + ' 种'
                : '实时标记：当前界面已全部翻译';
        }, 900);

        /* -------------------------------------------------- 7. 交互绑定 */
        const chkAuto = $('chkAuto');
        const chkRebirth = $('chkRebirth');

        chkAuto.checked = !!cfg.autoMark;
        chkRebirth.checked = !!cfg.autoRebirth;

        chkAuto.addEventListener('change', () => {
            cfg.autoMark = chkAuto.checked;
            saveCfg();
            if (!cfg.autoMark) { clearMarks(MARK_LIVE); }
        });
        chkRebirth.addEventListener('change', () => {
            cfg.autoRebirth = chkRebirth.checked;
            saveCfg();
        });

        // 折叠 / 隐藏
        let collapsed = false;
        $('btnMin').addEventListener('click', () => {
            collapsed = !collapsed;
            bdEl.classList.toggle('hidden', collapsed);
            shadow.querySelector('.ft').classList.toggle('hidden', collapsed);
            $('btnMin').textContent = collapsed ? '+' : '—';
        });

        function setHidden(h) {
            boxEl.classList.toggle('hidden', h);
            badgeEl.classList.toggle('hidden', !h);
        }
        $('btnHide').addEventListener('click', () => setHidden(true));
        badgeEl.addEventListener('click', () => setHidden(false));

        // 拖拽
        (function drag() {
            const hd = $('hd');
            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

            hd.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                const r = boxEl.getBoundingClientRect();
                dragging = true;
                sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
                boxEl.style.left = r.left + 'px';
                boxEl.style.top = r.top + 'px';
                boxEl.style.right = 'auto';
                boxEl.style.bottom = 'auto';
                hd.setPointerCapture(e.pointerId);
            });
            hd.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                boxEl.style.left = (ox + e.clientX - sx) + 'px';
                boxEl.style.top = (oy + e.clientY - sy) + 'px';
            });
            hd.addEventListener('pointerup', (e) => {
                dragging = false;
                try { hd.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            });
        })();

        // 快捷键
        window.addEventListener('keydown', (e) => {
            if (!e.altKey) return;
            if (e.code === 'KeyT') {
                e.preventDefault(); e.stopPropagation();
                setHidden(!boxEl.classList.contains('hidden'));
            } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation();
                speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, speedIdx + (e.code === 'ArrowUp' ? 1 : -1)));
                setMult(SPEEDS[speedIdx]);
            }
        }, true);

        /* -------------------------------------------------- 8. 收尾 */
        setMult(state.mult >= MAX_MULT ? 'max' : state.mult);
        refreshStats();
        console.log('[PKQ-TS] 已加载：Alt+T 开关面板，Alt+↑/↓ 调速');
    }
})();
