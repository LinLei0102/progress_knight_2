/**
 * 生成"毕业存档"（宣传截图用）
 * ------------------------------------------------------------------
 * 流程（两遍，保证数值自洽）：
 *   1) jsdom 启动游戏 → 把 gameData 篡改到终局状态 → 导出草稿 JSON
 *   2) 把草稿重新导入一个全新实例 → 读游戏自己算出来的 totalIncome /
 *      totalExpense / 每秒产出 → 按这些真实速率折算资源 → 出最终存档
 *
 * 为什么要两遍：第一遍里我们直接改了内存对象，但 `restorePrototypes()` /
 * `addMultipliers()` 在读档时会重新计算一堆派生值，导致内存里的 totalIncome
 * 和读档后的并不一致。以"读档后的实际值"为准才自洽。
 *
 * 为什么必须 paused：终局速度 = 时间扭曲 ×时空维度 ×时间循环 × 2 ×1000 ×1000，
 * 高达 1e18 量级，跑一帧年龄就飙到 1e17。暂停后 getGameSpeed() 归零，
 * 画面冻结，但 updateTotalIncome() 照常结算，数值栏该有的都有。
 *
 * 用法：
 *   node tools/make-endgame-save.js            # 生成 + 摘要
 *   node tools/make-endgame-save.js --verify   # 生成 + 重新导入校验
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const OUT_DIR = path.join(root, 'saves');
const OUT_TXT = path.join(OUT_DIR, '毕业存档_宣传用.txt');
const OUT_JSON = path.join(OUT_DIR, '毕业存档_可读版.json');

/* ----------------------------- 参数 ----------------------------- */
const CFG = {
    // 各职业/技能等级（不给就用 default）。刻意做成参差不齐，像真玩家
    level: {
        'Beggar': 512, 'Farmer': 498, 'Fisherman': 486, 'Miner': 471, 'Blacksmith': 460, 'Merchant': 448,
        'Squire': 495, 'Footman': 483, 'Veteran footman': 470, 'Centenary': 458, 'Knight': 446,
        'Veteran Knight': 434, 'Holy Knight': 422, 'Lieutenant General': 410,
        'Student': 488, 'Apprentice Mage': 476, 'Adept Mage': 464, 'Master Wizard': 452,
        'Archmage': 440, 'Chronomancer': 428, 'Chairman': 416, 'Imperator': 404,
        'Corrupted': 372, 'Void Slave': 361, 'Void Fiend': 350, 'Abyss Anomaly': 339,
        'Void Wraith': 328, 'Void Reaver': 317, 'Void Lord': 306, 'Abyss God': 295,
        'Eternal Wanderer': 268, 'Nova': 259, 'Sigma Proioxis': 250, 'Acallaris': 241,
        'One Above All': 232,
        'Snow Crash': 84, 'Player One': 76, 'Lost in the dark': 68, 'Omega': 60,
        'default': 420,
    },

    ageYears: 1284,
    darkOrbs: 4.6e5,
    hypercubes: 1.8e7,
    perkPoints: 14286,
    evilPerkPoints: 8834,
    rebirth: [312, 187, 96, 47, 21],
    challenges: [42, 33, 27, 19, 16, 13],
    realtime: 3600 * 486 + 60 * 23,
};

/* --------------------------- 启动工具 --------------------------- */
function boot(opts = {}) {
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
            w.alert = (m) => errs.push('ALERT: ' + m);
            try {
                w.localStorage.setItem('pk_quest_language', process.env.PK_LANG || 'zh-CN');
                if (opts.save) w.localStorage.setItem('gameDataSave', opts.save);
            } catch (e) { /* ignore */ }
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
        throw new Error('脚本执行失败: ' + e.message);
    }
    return { dom, errs, ctx: dom.getInternalVMContext() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------- 篡改到终局状态 ------------------------- */
function applyEndgame(W) {
    const g = W.gameData;

    // 1) 全部需求完成 —— 解锁所有职业分类、技能线、挑战、里程碑、元宇
    for (const key in g.requirements) {
        g.requirements[key].completed = true;
        g.requirements[key].needs_rerender = true;
    }

    // 2) 职业 / 技能：解锁 + 英雄化 + 按表给等级
    for (const key in g.taskData) {
        const t = g.taskData[key];
        const lv = CFG.level[key] ?? CFG.level.default;
        t.unlocked = true;
        t.isHero = true;
        t.level = lv;
        t.maxLevel = lv;
        t.xp = new W.Decimal(0);
        g.savedMaxLevels[key] = lv;
        g.viewedTabs[key] = true;
    }

    // 3) 物品全部解锁并英雄化
    for (const key in g.itemData) {
        g.itemData[key].unlocked = true;
        g.itemData[key].isHero = true;
    }

    // 4) 转生 / 挑战
    const [r1, r2, r3, r4, r5] = CFG.rebirth;
    g.rebirthOneCount = r1; g.rebirthOneTime = 3600 * 2.4;
    g.rebirthTwoCount = r2; g.rebirthTwoTime = 3600 * 7.1;
    g.rebirthThreeCount = r3; g.rebirthThreeTime = 3600 * 33;
    g.rebirthFourCount = r4; g.rebirthFourTime = 3600 * 78;
    g.rebirthFiveCount = r5; g.rebirthFiveTime = 3600 * 195;
    Object.keys(g.challenges).forEach((k, i) => { g.challenges[k] = CFG.challenges[i] ?? 0; });

    // 5) 邪恶天赋 / 元宇天赋 / 暗物质商店
    for (const k in g.evil_perks) g.evil_perks[k] = 5;
    for (const k in g.perks) g.perks[k] = true;

    const shop = g.dark_matter_shop;
    shop.dark_orb_generator = 34;
    shop.a_deal_with_the_chairman = 7;
    shop.a_gift_from_god = 5;
    shop.life_coach = 4;
    shop.gotta_be_fast = 3;
    shop.a_miracle = true;
    shop.speed_is_life = 1;
    shop.your_greatest_debt = 1;
    shop.essence_collector = 1;
    shop.explosion_of_the_universe = 1;
    shop.multiverse_explorer = 1;

    Object.assign(g.metaverse, {
        boost_cooldown_modifier: Math.pow(0.9, 8),
        boost_timer_modifier: Math.pow(1.2, 6),
        boost_warp_modifier: 100 * Math.pow(2, 3),
        hypercube_gain_modifier: 4,
        evil_tran_gain: 1e8,
        essence_gain_modifier: Math.pow(1.5, 5),
        challenge_altar: 1,
        dark_mater_gain_modifer: 2,
    });

    // 6) 当前居所与杂物
    g.currentProperty = g.itemData['Planet'];
    g.currentMisc = [
        g.itemData['Universe Fragment'],
        g.itemData['Void Blade'],
        g.itemData['Celestial Robe'],
        g.itemData["Mind's Eye"],
    ];

    // 7) 统计（速率类等第二遍读档后按实际值覆盖）
    g.stats.maxEssenceReached = 1.2e58;
    g.stats.fastest1 = 3600 * 1.4;
    g.stats.fastest2 = 3600 * 4.8;
    g.stats.fastest3 = 3600 * 19;
    g.stats.fastest4 = 3600 * 52;
    g.stats.fastestGame = 3600 * 128;
    g.stats.startDate = new Date(Date.now() - CFG.realtime * 1000);

    // 8) 其它
    g.boost_active = false;
    g.boost_cooldown = 0;
    g.boost_timer = 0;
    g.active_challenge = '';
    g.timeWarpingEnabled = true;
    g.paused = false;      // 先放开，让 update() 正常结算

    W.setCustomEffects?.();
    W.initializeSkillBindings?.();
    W.initializeItemBindings?.();
    W.addMultipliers?.();
    W.updateAllChallengeBonusCache?.();
}

/* --------------------------- 主流程 --------------------------- */
(async () => {
    /* ---- 第一遍：造出草稿 ---- */
    const A = boot();
    await sleep(600);
    applyEndgame(A.dom.window);
    A.dom.window.gameData.paused = true;          // 冻结，避免 update 推飞天数与资源
    for (let i = 0; i < 5; i++) {
        try { A.dom.window.update(); } catch (e) { A.errs.push('update: ' + e.message); break; }
    }

    const draft = JSON.parse(JSON.stringify(A.dom.window.gameData));
    const requirementsPlain = draft.requirements;

    /* ---- 第二遍：把草稿读回来，取游戏真实算出的速率 ---- */
    const draftForLoad = JSON.parse(JSON.stringify(draft));
    delete draftForLoad.requirements;
    draftForLoad.completed_requirements = Object.keys(requirementsPlain).filter(k => requirementsPlain[k].completed);
    draftForLoad.save_date_time = Date.now();

    const B = boot({ save: JSON.stringify(draftForLoad) });
    await sleep(700);
    for (let i = 0; i < 3; i++) {
        try { B.dom.window.update(); } catch (e) { B.errs.push('update2: ' + e.message); break; }
    }
    const g1 = B.dom.window.gameData;
    const totalIncome = vm.runInContext('totalIncome', B.ctx);
    const totalExpense = vm.runInContext('totalExpense', B.ctx);
    const stats = g1.stats;

    /* ---- 按真实速率折算资源，写进最终存档 ---- */
    const finalSave = JSON.parse(JSON.stringify(draft));
    finalSave.days = 365 * CFG.ageYears + 217;
    finalSave.totalDays = Math.round(finalSave.days * 1.62);
    finalSave.realtime = CFG.realtime;
    finalSave.realtimeRun = CFG.realtime;
    finalSave.is_alive = true;
    finalSave.paused = true;                      // 载入即暂停，画面冻结
    finalSave.save_date_time = 0;                 // 不触发离线结算

    // 金币取「收入 × 若干天」与「最后一件居所(牧夫座空洞)门槛 1e152」两者较大值，
    // 保证 242/242 需求全完成，最后一件物品也点亮
    finalSave.coins = Math.max(totalIncome * 4.7, 1e152);
    finalSave.evil = Math.max(stats.EvilPerSecond, 1) * 86400 * 26;
    finalSave.essence = Math.max(stats.EssencePerSecond, 1) * 86400 * 11;
    finalSave.dark_matter = 2.5e15;
    finalSave.dark_orbs = CFG.darkOrbs;
    finalSave.hypercubes = CFG.hypercubes;
    finalSave.perks_points = CFG.perkPoints;
    finalSave.evil_perks_points = CFG.evilPerkPoints;
    finalSave.stats = Object.assign({}, g1.stats, {
        maxEssenceReached: Math.max(stats.maxEssenceReached || 0, 1.2e58),
        startDate: new Date(Date.now() - CFG.realtime * 1000),
        fastest1: 3600 * 1.4,
        fastest2: 3600 * 4.8,
        fastest3: 3600 * 19,
        fastest4: 3600 * 52,
        fastestGame: 3600 * 128,
    });

    const saveString = A.dom.window.btoa(JSON.stringify(finalSave));
    if (!/^[\x20-\x7E\r\n]+$/.test(saveString)) throw new Error('存档串含非 ASCII 字符');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_TXT, saveString, 'utf8');

    const readable = JSON.parse(JSON.stringify(finalSave));
    delete readable.requirements;
    readable.completed_requirements = Object.keys(requirementsPlain).filter(k => requirementsPlain[k].completed);
    fs.writeFileSync(OUT_JSON, JSON.stringify(readable, null, 2), 'utf8');

    const W = A.dom.window;
    const f = (n) => W.format(n);
    console.log('=== 存档已生成 ===');
    console.log('文件       :', path.relative(root, OUT_TXT));
    console.log('长度       :', saveString.length, '字符（base64）');
    console.log('年龄       :', W.formatAge(finalSave.days));
    console.log('寿命       : 无限');
    console.log('余额       :', f(finalSave.coins));
    console.log('收入/支出  :', f(totalIncome), '/', f(totalExpense));
    console.log('幸福       :', f(W.getHappiness()));
    console.log('邪恶       :', f(finalSave.evil));
    console.log('精华       :', f(finalSave.essence));
    console.log('暗物质     :', f(finalSave.dark_matter));
    console.log('暗质球     :', f(finalSave.dark_orbs));
    console.log('超立方体   :', f(finalSave.hypercubes));
    console.log('时间扭曲   : x' + f(finalSave.game_speed / 4));
    const al = [...A.errs, ...B.errs];
    if (al.length) {
        console.log('\n=== 运行期告警 ===');
        al.slice(0, 6).forEach(e => console.log(' !', e));
    }

    if (process.argv.includes('--verify')) await verify(saveString);
    process.exit(0);
})();

/* --------------------------- 校验 --------------------------- */
async function verify(saveString) {
    console.log('\n=== 重新导入校验 ===');
    const data = JSON.parse(Buffer.from(saveString, 'base64').toString('utf8'));

    const { requirements, ...saveCopy } = data;
    saveCopy.save_date_time = Date.now();
    saveCopy.completed_requirements = Object.keys(requirements).filter(k => requirements[k].completed);

    const { dom, errs } = boot({ save: JSON.stringify(saveCopy) });
    await sleep(1000);
    const W = dom.window;
    try { W.updateUI(); W.renderSideBar(); } catch (e) { errs.push('render: ' + e.message); }

    const g = W.gameData;
    const d = W.document;
    const pick = (id) => {
        const el = d.getElementById(id);
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '(null)';
    };

    const rows = [
        ['年龄', 'ageDisplay'], ['寿命', 'lifespanDisplay'], ['余额', 'coinDisplay'],
        ['净收入', 'netDisplay'], ['收入', 'incomeDisplay'], ['支出', 'expenseDisplay'],
        ['幸福', 'happinessDisplay'], ['邪恶', 'evilDisplay'], ['精华', 'essenceDisplay'],
        ['暗物质', 'darkMatterDisplay'], ['暗质球', 'darkOrbsDisplay'],
        ['时间扭曲', 'timeWarpingDisplay'], ['超立方体', 'hypercubesDisplay'],
    ];
    for (const [label, id] of rows) console.log(label.padEnd(6), ':', pick(id));

    console.log('存活      :', g.is_alive);
    console.log('暂停      :', g.paused);
    console.log('需求完成  :', Object.values(g.requirements).filter(r => r.completed).length, '/', Object.keys(g.requirements).length);
    console.log('职业首行  :', pick('rowBeggar'));
    console.log('运行时错误:', errs.length ? errs.slice(0, 5) : '（无）');
}
