/**
 * 无头冒烟测试：用 jsdom 加载 index.html，执行全部脚本，
 * 抓取运行时错误，并抽样打印渲染后的文本，确认汉化生效。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
    // 资源加载类错误（图片等）不关心
    const msg = String(e && e.message || e);
    if (/Could not load img|Not implemented: HTMLCanvasElement|css/i.test(msg)) return;
    errors.push('jsdomError: ' + msg);
});
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    resources: undefined,           // 不自动加载外部资源，手动注入
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
        window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
        window.HTMLCanvasElement.prototype.getContext = () => null;
        if (window.URL && !window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:stub';
        if (!window.URL) window.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() { } };
        window.onerror = (msg) => { errors.push('onerror: ' + msg); };
        try { window.localStorage.setItem('pk_quest_language', process.env.PK_LANG || 'zh-CN'); } catch (e) { }
    }
});

const { window } = dom;

// 按 index.html 里的顺序把所有脚本拼成一段，在同一个全局词法环境里执行
// （浏览器中多个 <script> 共享全局作用域，逐个 window.eval 会拆散 const 声明）
const vm = require('vm');
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
const chunks = [];
for (const src of scripts) {
    const file = path.join(root, src);
    if (!fs.existsSync(file)) { errors.push('missing script ' + src); continue; }
    chunks.push(`\n/* ===== ${src} ===== */\n` + fs.readFileSync(file, 'utf8'));
}
try {
    const ctx = dom.getInternalVMContext();
    vm.runInContext(chunks.join('\n'), ctx, { filename: 'bundle.js' });
} catch (e) {
    const frame = (e.stack || '').split('\n')[0];
    errors.push(`bundle: ${e.constructor.name}: ${e.message}  @ ${frame}`);
}

setTimeout(() => {
    const d = window.document;
    const pick = (sel) => {
        const el = d.querySelector(sel);
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : '(null)';
    };

    console.log('=== 语言 ===', window.I18N && window.I18N.locale, 'html lang =', d.documentElement.getAttribute('lang'));
    console.log('=== 标题 ===', d.title);
    console.log('--- 标签页 ---');
    ['infoTabButton', 'jobsTabButton', 'skillsTabButton', 'shopTabButton', 'evilperksTabButton',
        'challengesTabButton', 'milestonesTabButton', 'rebirthTabButton', 'darkMatterTabButton',
        'metaverseTabButton', 'settingsTabButton'].forEach(id => {
            console.log('  ', id, '=>', pick('#' + id));
        });

    console.log('--- 职业表 ---');
    const rows = d.querySelectorAll('#jobTable .tr');
    let n = 0;
    rows.forEach(r => {
        if (n++ > 8) return;
        console.log('  ', (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70));
    });

    console.log('--- 侧边栏 ---');
    ['ageDisplay', 'pauseButton', 'happinessDisplay', 'timeWarpingDisplay'].forEach(id => {
        console.log('  ', id, '=>', pick('#' + id));
    });

    console.log('--- 设置项 ---');
    console.log('   languageButtons =>', (d.querySelector('#languageButtons') || {}).textContent);

    // 直接渲染一个职业 / 里程碑 tooltip，检查标签与正文
    try {
        const dummy = d.createElement('div');
        window.renderTooltipContent(dummy, 'Knight', 'job');
        console.log('--- 职业 Tooltip ---');
        console.log('  ', (dummy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160));
        const d2 = d.createElement('div');
        window.renderTooltipContent(d2, 'Magic Eye', 'milestone');
        console.log('--- 里程碑 Tooltip ---');
        console.log('  ', (d2.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160));
    } catch (e) { errors.push('tooltip: ' + e.message); }

    console.log('--- 里程碑表 ---');
    let k = 0;
    d.querySelectorAll('#milestoneTable .tr').forEach(r => {
        if (k++ > 5) return;
        console.log('  ', (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70));
    });

    console.log('\n=== 运行时错误 ===');
    if (!errors.length) console.log('   (无)');
    else errors.slice(0, 20).forEach(e => console.log('  !', e));
    process.exit(0);
}, 500);
