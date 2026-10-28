/* ============================================================================
 * i18n.js —— 轻量本地化层（默认英文，可加载任意语言包）
 * ----------------------------------------------------------------------------
 * 设计原则
 *   1. 游戏内部数据一律保留英文原名作为 key（taskData / requirements / rowId …
 *      都依赖它），本层只翻译「显示层」，绝不改写数据；
 *   2. 每个取词函数都有兜底，缺词条时原样返回英文，永不抛错；
 *   3. 新增语言 = 新增一个 js/lang/xxx.js，不改引擎。
 *
 * 用法
 *   I18N.t('Income')                  // 词条
 *   I18N.t('pause', 'Pause')          // 带英文兜底
 *   I18N.n('Knight')                  // 实体显示名，未收录则返回 Knight
 *   I18N.d('Skill XP')                // 短描述
 *   I18N.f('age_days', 'Age {a} Day {d}', {a:14, d:0})
 *   I18N.attach()                     // 翻译 index.html 里的静态文本
 * ==========================================================================*/
var I18N = (function (global) {
    'use strict';

    var STORAGE_KEY = 'pk_quest_language';
    var FALLBACK = 'en';
    var packs = {};
    var locale = FALLBACK;
    var active = false;          // locale !== en 时为 true

    /* ---------------------------------------------------------------- 注册 */
    var registry = global.PK_LANG || {};
    for (var code in registry) {
        if (Object.prototype.hasOwnProperty.call(registry, code)) packs[code] = registry[code];
    }

    function hasPack(code) {
        return code === FALLBACK || Object.prototype.hasOwnProperty.call(packs, code);
    }

    function detect() {
        var saved = null;
        try { saved = global.localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
        if (saved && hasPack(saved)) return saved;

        // 首次进入跟随浏览器语言（zh-* → 简体中文）
        var nav = '';
        try { nav = (global.navigator.language || '').toLowerCase(); } catch (e) { nav = ''; }
        if (nav.indexOf('zh') === 0) {
            if (nav.indexOf('tw') >= 0 || nav.indexOf('hk') >= 0 || nav.indexOf('hant') >= 0) {
                // 暂未提供繁体包，先回落到简体
                if (hasPack('zh-CN')) return 'zh-CN';
            }
            if (hasPack('zh-CN')) return 'zh-CN';
        }
        return FALLBACK;
    }

    function pack() {
        return packs[locale] || null;
    }

    function table(name) {
        var p = pack();
        return (p && p[name]) || null;
    }

    /* ------------------------------------------------------------- 取词 API */
    /** 界面词条 */
    function t(key, fallback) {
        var tab = table('ui');
        if (tab && key != null && Object.prototype.hasOwnProperty.call(tab, key)) return tab[key];
        return fallback !== undefined ? fallback : key;
    }

    /** 实体显示名（英文原名 → 本地名） */
    function n(key) {
        if (key == null) return key;
        var tab = table('names');
        if (tab && Object.prototype.hasOwnProperty.call(tab, key)) return tab[key];
        return key;
    }

    /** 短描述 */
    function d(key) {
        if (key == null) return key;
        var tab = table('desc');
        if (tab && Object.prototype.hasOwnProperty.call(tab, key)) return tab[key];
        return key;
    }

    /** 长文本（tooltip 正文等），未收录则用传入的英文 */
    function lore(key, fallback) {
        var tab = table('lore');
        if (tab && key != null && Object.prototype.hasOwnProperty.call(tab, key)) return tab[key];
        return fallback !== undefined ? fallback : key;
    }

    /** 模板插值：{name} 形式 */
    function f(key, fallback, vars) {
        var pattern = t(key, fallback);
        if (vars) {
            pattern = String(pattern).replace(/\{(\w+)\}/g, function (m, k) {
                return (vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : '';
            });
        }
        return pattern;
    }

    /** 无语言包时返回 fallback，用于拼接 */
    function zh() { return active; }

    /* ------------------------------------------------------ 静态 DOM 翻译 */
    function normalize(text) {
        return String(text).replace(/\s+/g, ' ').trim();
    }

    function translateTextNodes(root, tab) {
        if (!root || typeof document === 'undefined') return;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                var parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                var tag = parent.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                if (parent.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var raw = node.nodeValue;
            if (!raw) continue;
            var key = normalize(raw);
            if (!key) continue;
            if (!Object.prototype.hasOwnProperty.call(tab, key)) continue;

            var lead = (raw.match(/^\s*/) || [''])[0];
            var trail = (raw.match(/\s*$/) || [''])[0];
            node.nodeValue = lead + tab[key] + trail;
        }
    }

    var ATTRS = ['placeholder', 'title', 'alt', 'data-short'];

    function translateAttributes(root, tab) {
        if (!root || !root.querySelectorAll) return;
        for (var a = 0; a < ATTRS.length; a++) {
            var attr = ATTRS[a];
            var list = root.querySelectorAll('[' + attr + ']');
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                var val = el.getAttribute(attr);
                if (!val) continue;
                var key = normalize(val);
                if (Object.prototype.hasOwnProperty.call(tab, key)) el.setAttribute(attr, tab[key]);
            }
        }
    }

    function translateTemplates(tab) {
        if (typeof document === 'undefined') return;
        var tpls = document.querySelectorAll('template');
        for (var i = 0; i < tpls.length; i++) {
            var content = tpls[i].content;
            if (!content) continue;
            translateTextNodes(content, tab);
            translateAttributes(content, tab);
        }
    }

    function applyBlocks(tab) {
        if (typeof document === 'undefined') return;
        var blocks = document.querySelectorAll('[data-i18n-block]');
        for (var i = 0; i < blocks.length; i++) {
            var el = blocks[i];
            var key = el.getAttribute('data-i18n-block');
            if (!key) continue;
            if (Object.prototype.hasOwnProperty.call(tab, key)) {
                el.innerHTML = tab[key];
            }
        }
    }

    /** 把页面上的静态英文替换成当前语言 */
    function apply() {
        if (!active || typeof document === 'undefined') return;
        var stat = table('static');
        var loreTab = table('lore');

        if (loreTab) applyBlocks(loreTab);
        if (stat) {
            translateTextNodes(document.body, stat);
            translateAttributes(document.body, stat);
            translateTemplates(stat);
        }

        if (pack() && pack().htmlLang) {
            document.documentElement.setAttribute('lang', pack().htmlLang);
            document.documentElement.setAttribute('data-lang', locale);
        }
        if (stat && stat['Progress Knight Quest']) {
            document.title = stat['Progress Knight Quest'];
        }
    }

    /* ---------------------------------------------------------- 切换语言 */
    function setLocale(code) {
        if (!hasPack(code)) return false;
        try { global.localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* ignore */ }

        // 同步进存档，方便导出/导入时带上语言偏好
        try {
            if (typeof gameData !== 'undefined' && gameData && gameData.settings) {
                gameData.settings.language = code;
                if (typeof saveGameData === 'function') saveGameData();
            }
        } catch (e) { /* ignore */ }

        // 整页重载：最稳，避免动到已渲染的 DOM 与缓存
        try { global.location.reload(); } catch (e) { /* ignore */ }
        return true;
    }

    /* ------------------------------------------------------------ 初始化 */
    locale = detect();
    active = locale !== FALLBACK;

    if (active && typeof document !== 'undefined' && document.body) {
        // 脚本位于 body 末尾，此时 DOM 已解析完毕
        try { apply(); } catch (e) { console.error('[i18n] apply failed', e); }
    }

    /* ------------------------------------------------------- 语言选择按钮 */
    function mountLanguageButtons() {
        if (typeof document === 'undefined') return;
        var host = document.getElementById('languageButtons');
        if (!host) return;

        var list = [
            { code: FALLBACK, label: 'English' }
        ];
        for (var c in packs) {
            if (Object.prototype.hasOwnProperty.call(packs, c)) {
                list.unshift({ code: c, label: packs[c].label || c });
            }
        }

        host.innerHTML = '';
        for (var i = 0; i < list.length; i++) {
            (function (item) {
                var btn = document.createElement('button');
                btn.className = 'w3-button button Language';
                btn.textContent = item.label;
                if (item.code === locale) btn.classList.add('selected');
                btn.addEventListener('click', function () { setLocale(item.code); });
                host.appendChild(btn);
            })(list[i]);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountLanguageButtons);
    } else {
        mountLanguageButtons();
    }

    return {
        t: t,
        n: n,
        name: n,
        d: d,
        lore: lore,
        f: f,
        zh: zh,
        apply: apply,
        setLocale: setLocale,
        get locale() { return locale; },
        get isDefault() { return !active; },
        available: function () {
            var list = [];
            for (var c in packs) {
                if (Object.prototype.hasOwnProperty.call(packs, c)) {
                    list.push({ code: c, label: (packs[c].label || c) });
                }
            }
            list.push({ code: FALLBACK, label: 'English' });
            return list;
        }
    };
})(typeof window !== 'undefined' ? window : this);
