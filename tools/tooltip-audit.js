/**
 * Tooltip 全量审计：把每一种 tooltip 都真实渲染一遍，再扫里面的英文。
 * 覆盖度扫描只看首屏静态 DOM，那些悬停才出现的文本必须用这个查。
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
vc.on('error', (...a) => errs.push(a.join(' ')));

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
} catch (e) {
    console.error('bundle error:', e.message);
}

setTimeout(() => {
    const W = dom.window;
    const d = W.document;
    const seen = new Map();   // 英文串 -> 出现的 tooltip 类型

    const WORDS = /[A-Za-z]{2,}/;
    const NUMERICISH = /^[\d\s.,:%+\-x/()\[\]£$]*$/;

    function scanText(el, label) {
        const walker = d.createTreeWalker(el, 4, null);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const n of nodes) {
            const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (!t) continue;
            if (!WORDS.test(t)) continue;
            if (NUMERICISH.test(t)) continue;
            if (!seen.has(t)) seen.set(t, new Set());
            seen.get(t).add(label);
        }
    }

    function render(label, data, type) {
        const box = d.createElement('div');
        try {
            W.renderTooltipContent(box, data, type);
        } catch (e) {
            errs.push(`render ${type}/${data}: ${e.message}`);
            return;
        }
        scanText(box, `${type}:${data}`);
    }

    // 逐类枚举
    function sweepAll(tag) {
        for (const k in W.gameData.jobData) render(tag + 'job', k, 'job');
        for (const k in W.gameData.skillData) render(tag + 'skill', k, 'skill');
        for (const k in W.gameData.itemData) render(tag + 'item', k, 'item');
        for (const k in W.milestoneData) render(tag + 'milestone', k, 'milestone');
        for (const k in W.gameData.requirements) render(tag + 'requirement', k, 'requirement');
        for (let i = 1; i <= 5; i++) render(tag + 'evil_perk', String(i), 'evil_perk');
        for (const k in W.perk_names) render(tag + 'meta_perk', k, 'meta_perk');
        render(tag + 'dark_orbs', 'dark_orbs', 'dark_orbs');
        render(tag + 'simple', 'Click to activate auto-buy', 'simple');
    }

    // ---- 第一遍：新存档状态 ----
    sweepAll('');

    // ---- 第二遍：终局状态 ----
    // 很多文本只在"需求已完成""英雄已解锁""进入元宇"等分支里才出现，
    // 只跑新存档会漏掉。这里把状态推到很后面再扫一遍。
    try {
        for (const k in W.gameData.taskData) {
            const t = W.gameData.taskData[k];
            t.level = 1e6;
            t.maxLevel = 1e6;
            t.unlocked = true;
            if (typeof t.isHero !== 'undefined') t.isHero = true;
        }
        for (const k in W.gameData.requirements) {
            W.gameData.requirements[k].completed = true;
        }
        W.gameData.evil = 1e12;
        W.gameData.essence = 1e200;
        W.gameData.dark_matter = 1e12;
        W.gameData.dark_orbs = 1e12;
        W.gameData.hypercubes = 1e12;
        W.gameData.perks_points = 1e6;
        W.gameData.rebirthOneCount = 1;
        W.gameData.rebirthTwoCount = 1;
        W.gameData.rebirthThreeCount = 1;
        W.gameData.rebirthFourCount = 1;
        W.gameData.rebirthFiveCount = 1;
        if (W.gameData.stats) {
            W.gameData.stats.maxEssenceReached = 1e300;
            W.gameData.stats.EssencePerSecond = 1e6;
            W.gameData.stats.maxEssencePerSecond = 1e9;
            W.gameData.stats.maxEssencePerSecondRt = 3600;
        }
        for (const k in W.gameData.perks) W.gameData.perks[k] = true;
    } catch (e) {
        errs.push('endgame state: ' + e.message);
    }
    sweepAll('[终局]');

    // ---- 第三遍：动态字符串 ----
    // 挑战标题这类由 id 拼出来的文本，不会出现在任何 tooltip 里，必须单独验。
    try {
        for (const id of Object.keys(W.gameData.challenges)) {
            // 1) getFormattedTitle 的产物
            const title = W.getFormattedTitle(id);
            scanText((() => {
                const box = d.createElement('div');
                box.textContent = title;
                return box;
            })(), 'challengeTitle:' + id);

            // 2) 侧边栏"当前挑战"整块（含奖励描述）
            W.gameData.active_challenge = id;
            W.renderSideBar();
            const panel = d.getElementById('infoPage');
            if (panel) scanText(panel, 'challengePanel:' + id);
        }
        W.gameData.active_challenge = '';
        W.renderSideBar();
    } catch (e) {
        errs.push('challenge sweep: ' + e.message);
    }

    const arr = [...seen.entries()].sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length);
    console.log('tooltip 里未翻译的文本种类:', arr.length);
    for (const [t, labels] of arr) {
        const sample = [...labels].slice(0, 3).join(', ');
        console.log(String(labels.size).padStart(3), '|', t.length > 90 ? t.slice(0, 90) + '…' : t, ' <<', sample);
    }
    if (errs.length) {
        console.log('\n=== 错误 ===');
        errs.slice(0, 10).forEach(e => console.log(' !', e));
    }
    process.exit(0);
}, 600);
