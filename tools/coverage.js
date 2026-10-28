/**
 * 静态文本覆盖率扫描
 * ------------------------------------------------------------------
 * 两遍：
 *   1) 新存档状态，遍历所有主标签 / 子标签（内容会持久留在 DOM 里）
 *   2) 终局状态（英雄解锁、进入过元宇、所有需求完成），再遍历一遍
 * 这样只出现在后期才有的面板里的文本也能扫到。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
    const m = String((e && e.message) || e);
    if (/img|canvas|css|Not implemented/i.test(m)) return;
    errs.push(m);
});

const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
        w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
        w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
        w.HTMLCanvasElement.prototype.getContext = () => null;
        if (w.URL && !w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:stub';
        w.onerror = (m) => errs.push('onerror: ' + m);
        try { w.localStorage.setItem('pk_quest_language', process.env.PK_LANG || 'zh-CN'); } catch (e) { }
    }
});

const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
const chunks = scripts
    .map(s => path.join(root, s))
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'));
try {
    vm.runInContext(chunks.join('\n'), dom.getInternalVMContext(), { filename: 'bundle.js' });
} catch (e) { console.error('bundle error:', e.message); }

const TABS = ['info', 'jobs', 'skills', 'shop', 'evilperks', 'challenges', 'milestones', 'rebirth', 'darkMatter', 'metaverse', 'settings'];
const SETTINGS_TABS = ['settingsTab', 'statsTab', 'changelogTab'];
const DM_TABS = ['shopTab', 'skillTreeTab'];
const MV_TABS = ['metaverseTab1', 'metaverseTab2'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tourTabs(W) {
    for (const t of TABS) {
        try { W.setTab(t); } catch (e) { errs.push(`setTab(${t}): ${e.message}`); }
        await sleep(40);
        if (t === 'settings') {
            for (const s of SETTINGS_TABS) {
                try { W.setTabSettings(s); } catch (e) { /* ignore */ }
                await sleep(40);
            }
        }
        if (t === 'darkMatter') {
            for (const s of DM_TABS) {
                try { W.setTabDarkMatter(s); } catch (e) { /* ignore */ }
                await sleep(40);
            }
        }
        if (t === 'metaverse') {
            for (const s of MV_TABS) {
                try { W.setTabMetaverse(s); } catch (e) { /* ignore */ }
                await sleep(40);
            }
        }
    }
}

(async () => {
    await sleep(500);
    const W = dom.window;
    const d = W.document;

    await tourTabs(W);

    // ---- 推入终局状态，再走一遍 ----
    try {
        for (const k in W.gameData.taskData) {
            const t = W.gameData.taskData[k];
            t.level = 1e6; t.maxLevel = 1e6; t.unlocked = true;
        }
        for (const k in W.gameData.requirements) W.gameData.requirements[k].completed = true;
        W.gameData.evil = 1e12;
        W.gameData.essence = 1e200;
        W.gameData.dark_matter = 1e12;
        W.gameData.dark_orbs = 1e12;
        W.gameData.hypercubes = 1e12;
        W.gameData.perks_points = 1e6;
        W.gameData.evil_perks_points = 1e6;
        W.gameData.rebirthOneCount = 1;
        W.gameData.rebirthTwoCount = 1;
        W.gameData.rebirthThreeCount = 1;
        W.gameData.rebirthFourCount = 1;
        W.gameData.rebirthFiveCount = 1;
        W.gameData.coins = 1e30;
        for (const k in W.gameData.perks) W.gameData.perks[k] = true;
    } catch (e) { errs.push('endgame: ' + e.message); }
    await sleep(300);
    await tourTabs(W);
    await sleep(200);

    // ---- 扫描 ----
    const counts = new Map();
    const scan = (rootEl) => {
        const walker = d.createTreeWalker(rootEl, 4, {
            acceptNode(node) {
                const p = node.parentElement;
                if (!p) return 2;
                const tag = p.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return 2;
                if (p.closest('[data-i18n-skip]')) return 2;
                return 1;
            }
        });
        const list = [];
        while (walker.nextNode()) list.push(walker.currentNode);
        return list;
    };

    const NUMERICISH = /^[\d\s.,:%+\-x/()\[\]£$∞]*$/;
    const collect = (text) => {
        const t = (text || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        if (!/[A-Za-z]{2,}/.test(t)) return;
        if (NUMERICISH.test(t)) return;
        counts.set(t, (counts.get(t) || 0) + 1);
    };

    for (const node of scan(d.body)) collect(node.nodeValue);
    // 模板内容单独扫一遍；前缀要在过滤之后再拼，否则 "tpl" 本身会被当成英文
    const tplCounts = new Map();
    for (const tpl of d.querySelectorAll('template')) {
        for (const node of scan(tpl.content)) {
            const raw = (node.nodeValue || '');
            const t = raw.replace(/\s+/g, ' ').trim();
            if (!t) continue;
            if (!/[A-Za-z]{2,}/.test(t)) continue;
            if (NUMERICISH.test(t)) continue;
            tplCounts.set('[tpl] ' + t, (tplCounts.get('[tpl] ' + t) || 0) + 1);
        }
    }
    for (const [k, v] of tplCounts) counts.set(k, v);

    const arr = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    console.log('未翻译文本条数:', arr.length);
    for (const [t, c] of arr) {
        console.log(String(c).padStart(3), '|', t.length > 100 ? t.slice(0, 100) + '…' : t);
    }
    if (errs.length) {
        console.log('\n=== 错误 ===');
        errs.slice(0, 8).forEach(e => console.log(' !', e));
    }
    process.exit(0);
})();
