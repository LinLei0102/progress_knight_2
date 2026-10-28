# Progress Knight Quest · 简体中文版

A continuation of Progress Knight 2.0. Contains 5 prestige layers with various unique mechanics.

本仓库在原版基础上加入了**多语言系统**，并附带一份完整的简体中文翻译。

---

## 汉化版特性

- **语言切换**：设置 → 界面设置 → 语言，可在 `简体中文` / `English` 之间随时切换，切换后自动重新载入。
- **自动识别**：首次进入时会读取浏览器语言，`zh-*` 自动使用简体中文，其他语言保持原版英文。
- **偏好跟随存档**：语言选择同时写入 `localStorage` 和 `gameData.settings.language`，导出存档时一并带走。
- **存档完全兼容**：内部数据（职业 / 技能 / 物品 / 需求的 key）一律保持英文原名，翻译只发生在显示层。原版存档可以直接读，汉化存档也能切回英文，进度不会丢。
- **英文原版零改动**：语言为英文时，所有翻译逻辑直接短路，行为与原版一致。

覆盖范围包括：标签页、表头、全部 245 个实体名、侧边栏、设置面板、所有 tooltip（含需求追踪、英雄需求、元宇天赋、位面需求）、战斗提示、确认弹窗、存档提示、事件、更新日志，以及护符页的剧情叙述。

> 有意保留未译的部分：`MPP` / `EPP` 等游戏缩写，以及 `p / g / s / c`（便士 / 金币 / 银币 / 铜币）与 `k / M / B / T` 等数值单位后缀。

---

## 使用方法

纯静态页面，不需要构建：

```bash
# 任选一种方式起一个本地服务器
python -m http.server 8000
# 或
npx serve .
```

然后打开 `http://localhost:8000`。

直接双击 `index.html` 也能跑，但 `file://` 下部分浏览器的 `fetch` 受限，建议起服务器。

---

## 目录结构

```
index.html              页面结构与静态文案（含 <template> 行模板）
css/
  lang-zh.css           中文字体栈，仅在 <html lang="zh-CN"> 时生效
js/
  i18n.js               语言引擎：t / n / d / lore / f + 静态 DOM 扫描
  lang/
    zh-CN.js            简体中文词表（约 1000 条）
    zh-CN.changelog.js  中文更新日志（单独成文件，避免撑大主词表）
  ...                   其余为游戏逻辑，改动均为最小侵入
tools/                  本地自测工具（见下）
docs/汉化方案.md         实现细节、踩坑记录与后续计划
userscript/             开发用的倍速 + 未翻译扫描脚本
```

---

## 新增一门语言

翻译层与引擎是分开的，加语言不需要改任何逻辑：

1. 复制 `js/lang/zh-CN.js` 为 `js/lang/xx.js`，把 `window.PK_LANG['zh-CN']` 改成对应语言代码。
2. 词表分五块：
   - `ui`：界面固定词条
   - `names`：实体显示名（**英文原名作为 key**）
   - `desc`：短描述
   - `static`：`index.html` 里整节点精确匹配的静态文本
   - `lore`：长描述与整块替换的剧情 HTML
3. 在 `index.html` 里把新语言包加在 `js/i18n.js` 之前。
4. 语言按钮会自动出现。

引擎的取词函数全部带兜底：词表缺条目时原样返回英文，不会抛错，也不会渲染成 `undefined`。

---

## 自测工具

`tools/` 下是三个基于 jsdom 的无头脚本，用来保证没有漏翻、没有运行时错误。

```bash
cd tools
npm install

npm run coverage   # 扫静态 DOM（遍历所有标签页 + 推入终局状态再扫一遍）
npm run tooltip    # 枚举所有 tooltip 并真实渲染后扫描
npm run smoke      # 启动游戏，抓运行时错误 + 抽样渲染文本
```

三个脚本都支持 `PK_LANG=en` 环境变量，方便跑英文回归：

```bash
PK_LANG=en node tools/coverage.js
```

之所以要跑多遍：很多文本只在特定状态下才渲染（需求 tooltip 的"已完成"分支、元宇面板、暗物质能力、由 id 拼出来的挑战标题……），只扫首屏会漏得很惨。这一点在 `docs/汉化方案.md` 里有完整记录。

---

## 致谢

- 原作 [Progress Knight](https://ihtasham42.github.io/progress-knight/) by **Ihtasham42**
- 二创 [Progress Knight 2.0](https://symb1.github.io/progress_knight_2/) by **symb1**
- 本仓库基于 [LinLei0102/progress_knight_2](https://github.com/LinLei0102/progress_knight_2)

PRs which fix bugs are welcome :)
