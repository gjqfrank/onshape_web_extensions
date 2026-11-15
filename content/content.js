/**
 * Onshape BOM Filter — content script
 *
 * 在 Onshape 页面中自动检测 BOM（Bill of Materials，物料清单）表格，
 * 并注入一个筛选工具栏：可以按 BOM 的任意列属性（名称、零件编号、
 * 数量、材料、颜色等一切 BOM 包含的属性）筛选或高亮零件行。
 *
 * 纯 DOM 实现，不调用任何 Onshape API，不消耗 API 配额。
 */
(() => {
  'use strict';

  if (window.__onshapeBomFilterInjected) return;
  window.__onshapeBomFilterInjected = true;

  /* ============================ 配置 ============================ */

  const CONFIG = {
    // 用于识别 BOM 表的表头关键词（多语言，统一小写比较）
    bomHeaderKeywords: [
      // 英文
      'item', 'item number', 'item no', 'part number', 'part no',
      'quantity', 'qty', 'description', 'material', 'name',
      'revision', 'reference designator', 'designator',
      // 中文
      '序号', '项目', '数量', '零件编号', '零件号', '编号',
      '描述', '说明', '材料', '材质', '名称', '版本',
      // 其他常见语言
      'quantité', 'menge', 'cantidad', 'quantità', 'bezeichnung',
      'werkstoff', 'matériau', 'numéro de pièce', 'teilenummer', '수량'
    ],
    // BOM 特有列（Item 列在 Onshape 中固定存在），用于降低误检
    strongKeywords: [
      'item', 'item number', 'item no', 'quantity', 'qty',
      '序号', '项目', '数量'
    ],
    // 表格位于 "bom 容器" 内时，表头至少命中的关键词数
    minHeaderMatchesInBomContainer: 1,
    // 无法识别容器时，表头至少命中的关键词数
    minHeaderMatches: 2,
    // 最少列数
    minColumns: 2,
    // 防抖延迟（毫秒）
    debounceMs: 150,
    dirtyApplyMs: 80
  };

  const UI_TEXT = {
    title: 'BOM 筛选',
    anyColumn: '任意列',
    ops: [
      ['contains', '包含'],
      ['exact', '精确'],
      ['starts', '开头'],
      ['regex', '正则']
    ],
    addCondition: '+ 添加条件',
    modeFilter: '筛选',
    modeHighlight: '高亮',
    caseSensitive: 'Aa',
    clear: '清空',
    valuePlaceholder: '输入筛选值…'
  };

  /* ============================ 调试日志 ============================ */

  // 在控制台始终输出一条加载日志，便于确认脚本已注入。
  // 在 DevTools 控制台执行 localStorage.setItem('obfDebug','1') 并刷新，
  // 可打开详细检测日志；执行 window.__obf.help() 查看手动诊断命令。
  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem('obfDebug') === '1';
  } catch (e) { /* 某些 frame 中 localStorage 不可用 */ }

  function log(...args) {
    if (DEBUG) console.log('[BOM Filter]', ...args);
  }

  /* ============================ 工具函数 ============================ */

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn(...args);
      }, ms);
    };
  }

  // 规范化文本：合并空白并去除首尾空格
  function norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 单元格文本缓存（Onshape 重渲染会创建新节点，缓存自动失效）
  const textCache = new WeakMap();
  function cachedText(el) {
    let t = textCache.get(el);
    if (t === undefined) {
      t = norm(el.textContent || '');
      textCache.set(el, t);
    }
    return t;
  }

  function classText(node) {
    return (typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '');
  }

  // 向上查找类名/ID 含 "bom" 的容器
  function findBomContainer(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && node !== document.body && depth < 12) {
      if (/bom/i.test(classText(node))) return node;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  // 向上查找最近的可滚动祖先（用于粘性工具栏定位）
  function findScrollParent(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      try {
        const style = getComputedStyle(node);
        if (/(auto|scroll|overlay)/.test(style.overflowY + ' ' + style.overflow) &&
            node.scrollHeight > node.clientHeight) {
          return node;
        }
      } catch (e) {
        return null;
      }
      node = node.parentElement;
    }
    return null;
  }

  /* ============================ 表格适配器 ============================ */

  // 适配原生 <table> 的 BOM 表
  class HtmlTableAdapter {
    constructor(table) {
      this.table = table;
    }

    headerRow() {
      const thead = this.table.tHead;
      if (thead && thead.rows.length) return thead.rows[thead.rows.length - 1];
      const first = this.table.rows[0];
      if (!first) return null;
      const hasTh = Array.prototype.some.call(first.cells || [], c => c.tagName === 'TH');
      const text = norm(first.textContent || '').toLowerCase();
      const looksLikeHeader =
        hasTh || CONFIG.bomHeaderKeywords.some(kw => text.includes(kw));
      return looksLikeHeader ? first : null;
    }

    getHeaders() {
      const hr = this.headerRow();
      if (!hr) return [];
      return Array.prototype.map.call(hr.cells || [], c => cachedText(c));
    }

    getRows() {
      const hr = this.headerRow();
      const rows = [];
      for (const r of Array.from(this.table.rows)) {
        if (r === hr) continue;
        if (!r.cells || r.cells.length === 0) continue;
        rows.push(r);
      }
      return rows;
    }

    getCellCount(row) {
      return row.cells ? row.cells.length : 0;
    }

    getCellText(row, idx) {
      const cell = row.cells && row.cells[idx];
      return cell ? cachedText(cell) : '';
    }

    setRowVisible(row, visible) {
      if (visible) row.style.removeProperty('display');
      else row.style.setProperty('display', 'none', 'important');
    }

    setRowMatched(row, on) {
      row.classList.toggle('obf-match', on);
    }
  }

  // 适配 div 网格形式的 BOM 表（回退方案）
  class DivGridAdapter {
    constructor(root) {
      this.root = root;
    }

    findRows() {
      let all = Array.prototype.filter.call(
        this.root.querySelectorAll('[role="row"], div[class*="row"], li[class*="row"]'),
        r => !r.closest('.obf-root')
      );
      // 去掉嵌套在其他行内的行，避免重复计数
      all = all.filter(r => !all.some(o => o !== r && o.contains(r)));
      // 表头识别：类名特征 → 含 columnheader 单元格 → 文本命中 BOM 关键词的首行
      let header =
        all.find(r => /(^|\s)row[-_]?header|header[-_]?row|(^|\s)head(\s|$)/i.test(classText(r))) ||
        all.find(r => r.querySelector('[role="columnheader"]')) ||
        null;
      if (!header && all.length) {
        const first = all[0];
        const texts = this.cellsOf(first).map(c => cachedText(c));
        const { matches, strong } = countKeywordMatches(texts);
        if (matches >= 2 && strong) header = first;
      }
      return { header, rows: all.filter(r => r !== header) };
    }

    cellsOf(row) {
      const cells = row.querySelectorAll(
        '[role="cell"], [role="gridcell"], [class*="cell"]'
      );
      if (cells.length) return Array.prototype.slice.call(cells);
      return Array.prototype.slice.call(row.children);
    }

    getHeaders() {
      const { header } = this.findRows();
      if (!header) return [];
      return this.cellsOf(header).map(c => cachedText(c));
    }

    getRows() {
      return this.findRows().rows;
    }

    getCellCount(row) {
      return Math.max(this.cellsOf(row).length, 1);
    }

    getCellText(row, idx) {
      const cells = this.cellsOf(row);
      if (cells[idx]) return cachedText(cells[idx]);
      return idx === 0 ? cachedText(row) : '';
    }

    setRowVisible(row, visible) {
      if (visible) row.style.removeProperty('display');
      else row.style.setProperty('display', 'none', 'important');
    }

    setRowMatched(row, on) {
      row.classList.toggle('obf-match', on);
    }
  }

  // 适配 Onshape 原生 os-table 组件（BOM 表的真实结构）：
  // os-table.os-bom-table > .os-table > .os-colgroup-frozen / .os-colgroup-fluid，
  // 每个列组各有独立的 .os-thead/.os-tbody/.os-tr；
  // 一个逻辑行由各列组中同序号的 .os-tr 拼成，表头列按列组顺序拼接。
  class OsTableAdapter {
    constructor(root) {
      this.root = root;
    }

    colgroups() {
      const gs = Array.from(this.root.querySelectorAll('[class*="os-colgroup"]'));
      return gs.length ? gs : [this.root];
    }

    headerCells() {
      const cells = [];
      for (const g of this.colgroups()) {
        const thead = g.querySelector('.os-thead');
        if (!thead) continue;
        const hrows = thead.querySelectorAll('.os-tr');
        const hr = hrows[hrows.length - 1];
        if (!hr) continue;
        for (const c of Array.from(hr.querySelectorAll('.os-th'))) cells.push(c);
      }
      return cells;
    }

    getHeaders() {
      return this.headerCells().map(c => cachedText(c));
    }

    getRows() {
      const groups = [];
      for (const g of this.colgroups()) {
        // 数据行 = 列组内不在表头中的 .os-tr（兼容任意 tbody 容器类名）
        const rows = Array.from(g.querySelectorAll('.os-tr'))
          .filter(tr => !tr.closest('.os-thead') && !tr.closest('.obf-root'));
        if (rows.length) groups.push(rows);
      }
      if (!groups.length) return [];
      const n = Math.min(...groups.map(r => r.length));
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push({ els: groups.map(r => r[i]) });
      }
      return rows;
    }

    cellsOf(row) {
      if (!row._cells) {
        const cells = [];
        for (const tr of row.els) {
          let cs = Array.from(tr.querySelectorAll('.os-td'));
          if (!cs.length) cs = Array.from(tr.children);
          cells.push(...cs);
        }
        row._cells = cells;
      }
      return row._cells;
    }

    getCellCount(row) {
      return Math.max(this.cellsOf(row).length, 1);
    }

    getCellText(row, idx) {
      const cells = this.cellsOf(row);
      return cells[idx] ? cachedText(cells[idx]) : '';
    }

    setRowVisible(row, visible) {
      for (const el of row.els) {
        if (visible) el.style.removeProperty('display');
        else el.style.setProperty('display', 'none', 'important');
      }
    }

    setRowMatched(row, on) {
      for (const el of row.els) el.classList.toggle('obf-match', on);
    }
  }

  /* ============================ 匹配逻辑 ============================ */

  function compileMatcher(cond, caseSensitive) {
    if (cond.op === 'regex') {
      let re = null;
      try {
        re = new RegExp(cond.value.trim(), caseSensitive ? '' : 'i');
      } catch (e) {
        re = null; // 非法正则：不匹配任何内容
      }
      return (text) => !!re && re.test(text);
    }
    let value = cond.value.trim();
    if (!caseSensitive) value = value.toLowerCase();
    switch (cond.op) {
      case 'exact':
        return (text) => {
          const t = caseSensitive ? text : text.toLowerCase();
          return t.trim() === value;
        };
      case 'starts':
        return (text) => {
          const t = caseSensitive ? text : text.toLowerCase();
          return t.startsWith(value);
        };
      default: // contains
        return (text) => {
          const t = caseSensitive ? text : text.toLowerCase();
          return t.includes(value);
        };
    }
  }

  /* ============================ 筛选控制器 ============================ */

  class BomFilterController {
    constructor(host, adapter, root) {
      this.host = host;       // 表格元素（或 div 网格根）
      this.adapter = adapter; // 表格适配器
      this.root = root;       // 用于插入工具栏的参考容器
      this.conditions = [this.newCondition()];
      this.mode = 'filter';   // 'filter'（隐藏不匹配）| 'highlight'（高亮匹配）
      this.caseSensitive = false;
      this.headers = [];
      this.headerSig = '';
      this.collapsed = false;
      this.disposed = false;
      this.dirty = false;
      this.condEls = [];
      this.buildUI();
      this.refreshColumnOptions();
      this.applyFilter();
    }

    newCondition() {
      // column: -1 表示任意列
      return { column: -1, op: 'contains', value: '' };
    }

    /* ---------- UI 构建 ---------- */

    buildUI() {
      const toolbar = make('div', 'obf-root obf-toolbar');

      const head = make('div', 'obf-head');
      this.titleEl = make('span', 'obf-title', UI_TEXT.title);
      this.countEl = make('span', 'obf-count', '');
      const spacer = make('span', 'obf-spacer');

      // 模式切换（筛选 / 高亮）
      const seg = make('span', 'obf-seg');
      this.btnFilter = make('button', 'obf-active', UI_TEXT.modeFilter);
      this.btnHighlight = make('button', '', UI_TEXT.modeHighlight);
      this.btnFilter.type = 'button';
      this.btnHighlight.type = 'button';
      this.btnFilter.title = '隐藏不匹配的行';
      this.btnHighlight.title = '保持所有行可见，仅高亮匹配的行';
      this.btnFilter.addEventListener('click', () => this.setMode('filter'));
      this.btnHighlight.addEventListener('click', () => this.setMode('highlight'));
      seg.append(this.btnFilter, this.btnHighlight);

      // 区分大小写
      this.btnCase = make('button', 'obf-btn-icon obf-case', UI_TEXT.caseSensitive);
      this.btnCase.type = 'button';
      this.btnCase.title = '切换是否区分大小写';
      this.btnCase.addEventListener('click', () => {
        this.caseSensitive = !this.caseSensitive;
        this.btnCase.classList.toggle('obf-active', this.caseSensitive);
        this.applyFilter();
      });

      // 清空
      this.btnClear = make('button', '', UI_TEXT.clear);
      this.btnClear.type = 'button';
      this.btnClear.title = '清空所有筛选条件';
      this.btnClear.addEventListener('click', () => {
        this.conditions = [this.newCondition()];
        this.renderConditions();
        this.applyFilter();
      });

      // 收起 / 展开
      this.btnToggle = make('button', 'obf-btn-icon', '–');
      this.btnToggle.type = 'button';
      this.btnToggle.title = '收起 / 展开筛选栏';
      this.btnToggle.addEventListener('click', () => {
        this.collapsed = !this.collapsed;
        toolbar.classList.toggle('obf-collapsed', this.collapsed);
        this.btnToggle.textContent = this.collapsed ? '+' : '–';
      });

      head.append(this.titleEl, this.countEl, spacer, seg, this.btnCase, this.btnClear, this.btnToggle);

      this.bodyEl = make('div', 'obf-body');
      toolbar.append(head, this.bodyEl);
      this.toolbar = toolbar;

      // 选择插入位置：优先可滚动祖先（配合 sticky），其次 bom 容器，最后表格前方
      const scrollParent = findScrollParent(this.host);
      if (scrollParent) {
        scrollParent.insertBefore(toolbar, scrollParent.firstChild);
      } else if (this.root && this.root !== this.host && this.root.contains(this.host)) {
        this.root.insertBefore(toolbar, this.root.firstChild);
      } else if (this.host.parentElement) {
        this.host.parentElement.insertBefore(toolbar, this.host);
      }
      this.host.setAttribute('data-obf', '1');

      this.renderConditions();
    }

    renderConditions() {
      this.bodyEl.textContent = '';
      this.condEls = [];

      this.conditions.forEach((cond, i) => {
        const row = make('div', 'obf-cond');

        // 列选择
        const colSel = make('select', 'obf-col');
        colSel.title = '选择要筛选的列（BOM 包含的所有属性）';
        this.fillColumnOptions(colSel, cond.column);
        colSel.addEventListener('change', () => {
          cond.column = parseInt(colSel.value, 10);
          this.applyFilter();
        });

        // 匹配方式
        const opSel = make('select', 'obf-op');
        opSel.title = '匹配方式';
        for (const [val, label] of UI_TEXT.ops) {
          const opt = make('option', null, label);
          opt.value = val;
          opSel.append(opt);
        }
        opSel.value = cond.op;
        opSel.addEventListener('change', () => {
          cond.op = opSel.value;
          this.applyFilter();
        });

        // 筛选值
        const input = make('input', 'obf-val');
        input.type = 'text';
        input.placeholder = UI_TEXT.valuePlaceholder;
        input.value = cond.value;
        input.addEventListener('input', () => {
          cond.value = input.value;
          this.applyFilter();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.addCondition();
        });

        // 删除条件
        const del = make('button', 'obf-btn-icon obf-del', '×');
        del.type = 'button';
        del.title = '删除该条件';
        del.style.visibility = this.conditions.length > 1 ? 'visible' : 'hidden';
        del.addEventListener('click', () => {
          this.conditions.splice(i, 1);
          this.renderConditions();
          this.applyFilter();
        });

        row.append(colSel, opSel, input, del);
        this.bodyEl.append(row);
        this.condEls.push({ colSel });
      });

      const add = make('button', 'obf-add', UI_TEXT.addCondition);
      add.type = 'button';
      add.addEventListener('click', () => this.addCondition());
      this.bodyEl.append(add);
    }

    addCondition() {
      this.conditions.push(this.newCondition());
      this.renderConditions();
      const inputs = this.bodyEl.querySelectorAll('.obf-val');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    }

    fillColumnOptions(select, selected) {
      select.textContent = '';
      const anyOpt = make('option', null, UI_TEXT.anyColumn);
      anyOpt.value = '-1';
      select.append(anyOpt);
      this.headers.forEach((h, i) => {
        const opt = make('option', null, h || '第 ' + (i + 1) + ' 列');
        opt.value = String(i);
        select.append(opt);
      });
      select.value = String(selected);
      if (select.selectedIndex === -1) select.value = '-1';
    }

    /* ---------- 列头同步 ---------- */

    refreshColumnOptions() {
      const headers = this.adapter.getHeaders();
      const sig = headers.join('\u0000');
      if (sig === this.headerSig) return;
      const oldHeaders = this.headers || [];
      this.headerSig = sig;
      this.headers = headers;
      // 按列名重新映射已有条件的列索引（应对 Onshape 增删列）
      for (const cond of this.conditions) {
        if (cond.column >= 0) {
          const name = oldHeaders[cond.column];
          const idx = name ? headers.indexOf(name) : -1;
          cond.column = idx >= 0 ? idx : -1;
        }
      }
      if (this.condEls.length) {
        this.condEls.forEach(({ colSel }, i) => {
          const cond = this.conditions[i];
          if (cond) this.fillColumnOptions(colSel, cond.column);
        });
      }
    }

    /* ---------- 过滤 ---------- */

    rowMatches(row, matchers) {
      for (const { cond, fn } of matchers) {
        if (cond.column === -1) {
          const n = this.adapter.getCellCount(row);
          let any = false;
          for (let i = 0; i < n; i++) {
            if (fn(this.adapter.getCellText(row, i))) {
              any = true;
              break;
            }
          }
          if (!any) return false;
        } else if (!fn(this.adapter.getCellText(row, cond.column))) {
          return false;
        }
      }
      return true;
    }

    applyFilter() {
      if (this.disposed) return;
      const rows = this.adapter.getRows();
      const active = this.conditions.filter(c => c.value.trim() !== '');
      const matchers = active.map(c => ({
        cond: c,
        fn: compileMatcher(c, this.caseSensitive)
      }));

      let matched = 0;
      for (const row of rows) {
        const ok = matchers.length === 0 || this.rowMatches(row, matchers);
        if (this.mode === 'filter') {
          this.adapter.setRowVisible(row, matchers.length === 0 ? true : ok);
          this.adapter.setRowMatched(row, false);
        } else {
          this.adapter.setRowVisible(row, true);
          this.adapter.setRowMatched(row, matchers.length > 0 && ok);
        }
        if (ok) matched++;
      }
      this.updateCount(matched, rows.length, matchers.length > 0);
    }

    updateCount(matched, total, hasFilter) {
      this.countEl.textContent = hasFilter ? matched + ' / ' + total : String(total);
      this.countEl.title = hasFilter
        ? '匹配 ' + matched + ' 行，共 ' + total + ' 行'
        : '共 ' + total + ' 行';
      this.countEl.classList.toggle('obf-zero', hasFilter && matched === 0);
    }

    setMode(mode) {
      this.mode = mode;
      this.btnFilter.classList.toggle('obf-active', mode === 'filter');
      this.btnHighlight.classList.toggle('obf-active', mode === 'highlight');
      this.applyFilter();
    }

    dispose() {
      this.disposed = true;
      if (this.toolbar && this.toolbar.parentElement) {
        this.toolbar.parentElement.removeChild(this.toolbar);
      }
      try {
        this.host.removeAttribute('data-obf');
      } catch (e) { /* host 可能已脱离文档 */ }
    }
  }

  /* ============================ 检测与生命周期 ============================ */

  const controllers = new Set();

  function countKeywordMatches(headers) {
    const lowered = headers.map(h => (h || '').toLowerCase());
    let matches = 0;
    let strong = false;
    for (const kw of CONFIG.bomHeaderKeywords) {
      if (lowered.some(h => h.includes(kw))) {
        matches++;
        if (CONFIG.strongKeywords.includes(kw)) strong = true;
      }
    }
    return { matches, strong };
  }

  // 判断候选 f 是否与 c（已挂载控制器或已入选候选）指向同一张表，需去重。
  // Onshape 真实 DOM 中 contains() 关系与节点实例都可能不可靠（Angular
  // 重渲染会创建新节点），这里叠加多重信号：包含关系、共享表头单元格、
  // 几何重叠、bom 命名宿主优先。
  function isDuplicateHost(c, f) {
    try {
      if (!c.host || !c.host.isConnected) return false;
      if (c.host === f.host) return true;
      if (c.host.contains(f.host) || f.host.contains(c.host)) return true;
      if (c.adapter && f.adapter &&
          samePhysicalTable(c.adapter, f.adapter)) return true;
      // 几何去重：两宿主矩形重叠超过较小者的 50%
      const r1 = c.host.getBoundingClientRect();
      const r2 = f.host.getBoundingClientRect();
      const area = r => Math.max(0, r.width) * Math.max(0, r.height);
      const a1 = area(r1), a2 = area(r2);
      if (a1 > 0 && a2 > 0) {
        const iw = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
        const ih = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
        if (iw > 0 && ih > 0 && (iw * ih) / Math.min(a1, a2) > 0.5) return true;
      }
      // 已有 bom 命名宿主时，跳过泛化的 .os-table 候选
      if (/bom/i.test(classText(c.host)) && !/bom/i.test(classText(f.host)) &&
          f.adapter && typeof f.adapter.headerCells === 'function') return true;
    } catch (e) {
      return false;
    }
    return false;
  }

  // 判断两个适配器是否指向同一张物理表格（共享表头单元格）。
  // Onshape 中 os-table 包装元素与内层 .os-table 网格元素的 contains()
  // 关系可能不可靠，需用此兜底去重，避免挂出两个筛选栏。
  function samePhysicalTable(a, b) {
    try {
      if (typeof a.headerCells !== 'function' ||
          typeof b.headerCells !== 'function') return false;
      const ha = a.headerCells();
      const hb = b.headerCells();
      if (!ha.length || !hb.length) return false;
      const set = new Set(hb);
      return ha.some(c => set.has(c));
    } catch (e) {
      return false;
    }
  }

  // 扫描页面，返回可识别的 BOM 宿主（table 或 div 网格）
  function findBomHosts() {
    const found = [];

    // 1) 原生 <table>
    for (const table of Array.from(document.querySelectorAll('table'))) {
      if (table.closest('.obf-root')) continue;
      if (table.hasAttribute('data-obf')) continue;
      const adapter = new HtmlTableAdapter(table);
      const headers = adapter.getHeaders();
      if (headers.length < CONFIG.minColumns) continue;
      const { matches, strong } = countKeywordMatches(headers);
      const container = findBomContainer(table);
      const isBom = container
        ? matches >= CONFIG.minHeaderMatchesInBomContainer
        : (matches >= CONFIG.minHeaderMatches && strong);
      log('table 候选', table, 'headers=', headers, 'matches=', matches,
        'strong=', strong, 'bomContainer=', !!container, '→', isBom);
      if (!isBom) continue;
      found.push({ host: table, adapter, root: container || table.parentElement });
    }

    // 2) Onshape 原生 os-table 组件（BOM 表：冻结列 + 流动列拆分结构）
    for (const el of Array.from(document.querySelectorAll('os-table, .os-table'))) {
      if (el.closest('.obf-root')) continue;
      if (el.hasAttribute('data-obf')) continue;
      const adapter = new OsTableAdapter(el);
      if (found.some(ff => isDuplicateHost(ff, { host: el, adapter }))) continue;
      const headers = adapter.getHeaders();
      if (headers.length < CONFIG.minColumns) continue;
      const { matches, strong } = countKeywordMatches(headers);
      const named = /bom/i.test(classText(el)) || !!findBomContainer(el);
      const isBom = named
        ? matches >= CONFIG.minHeaderMatchesInBomContainer
        : (matches >= CONFIG.minHeaderMatches && strong);
      log('os-table 候选', el, 'headers=', headers, '→', isBom);
      if (isBom) found.push({ host: el, adapter, root: el });
    }

    // 3) div 网格：优先类名/ID 含 bom 的容器（宽松阈值），
    //    其次 role=grid/table 等网格语义元素（严格阈值）
    const containers = [];
    const seen = new Set();
    const bomSel = '[class*="bom" i], [id*="bom" i]';
    const gridSel = '[role="grid"], [role="table"], [role="treegrid"]';
    for (const el of Array.from(document.querySelectorAll(bomSel))) {
      if (el.nodeType === 1 && !el.closest('.obf-root') && !seen.has(el)) {
        seen.add(el);
        containers.push({ el, named: true });
      }
    }
    for (const el of Array.from(document.querySelectorAll(gridSel))) {
      if (el.nodeType === 1 && !el.closest('.obf-root') && !seen.has(el)) {
        seen.add(el);
        containers.push({ el, named: false });
      }
    }

    for (const { el: cont, named } of containers) {
      if (cont.hasAttribute('data-obf')) continue;
      if (cont.querySelector('table')) continue; // 已由上面的逻辑处理
      // 与已识别宿主重叠（祖先/后代）时跳过，避免重复挂载
      if (found.some(f => f.host.contains(cont) || cont.contains(f.host))) continue;
      const rows = cont.querySelectorAll('[role="row"], div[class*="row"], li[class*="row"]');
      if (rows.length < 2) {
        log('div 网格候选被跳过（行数不足）', cont);
        continue;
      }
      const adapter = new DivGridAdapter(cont);
      const headers = adapter.getHeaders();
      const { matches, strong } = countKeywordMatches(headers);
      const isBom = named
        ? (headers.length >= CONFIG.minColumns &&
           matches >= CONFIG.minHeaderMatchesInBomContainer)
        : (headers.length >= CONFIG.minColumns &&
           matches >= CONFIG.minHeaderMatches && strong);
      log('div 网格候选', cont, 'named=', named, 'headers=', headers,
        'matches=', matches, 'strong=', strong, '→', isBom);
      if (isBom) {
        found.push({ host: cont, adapter, root: cont });
      }
    }

    // bom 命名宿主排在前面（去重时作为保留方）
    found.sort((x, y) => {
      const nx = /bom/i.test(classText(x.host)) ? 0 : 1;
      const ny = /bom/i.test(classText(y.host)) ? 0 : 1;
      return nx - ny;
    });
    return found;
  }

  function scan() {
    // 清理已移除的表格对应的控制器
    for (const c of Array.from(controllers)) {
      if (!c.host.isConnected) {
        c.dispose();
        controllers.delete(c);
      }
    }
    // 为新出现的 BOM 表挂载筛选栏
    for (const f of findBomHosts()) {
      // 与所有已挂载控制器去重（覆盖 Angular 重渲染产生新节点、
      // 外层 os-table 包装与内层 .os-table 网格并存等场景）
      let dup = false;
      for (const c of controllers) {
        if (isDuplicateHost(c, f)) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      try {
        controllers.add(new BomFilterController(f.host, f.adapter, f.root));
        console.info('[BOM Filter] 已为 BOM 表挂载筛选栏:', f.host);
      } catch (e) {
        console.warn('[BOM Filter] 筛选栏挂载失败:', e);
      }
    }
  }

  function applyDirty() {
    for (const c of controllers) {
      if (!c.dirty) continue;
      c.dirty = false;
      c.refreshColumnOptions();
      c.applyFilter();
    }
  }

  const scheduleScan = debounce(scan, CONFIG.debounceMs);
  const scheduleApplyDirty = debounce(applyDirty, CONFIG.dirtyApplyMs);

  // 判断 mutation 是否由本扩展自身的 DOM 写入引起
  function isOwnMutation(m) {
    const t = m.target;
    if (t && t.nodeType === 1 && t.closest && t.closest('.obf-root')) return true;
    if (t && t.nodeType === 3 && t.parentElement && t.parentElement.closest('.obf-root')) return true;
    const nodes = [];
    if (m.addedNodes) for (const n of Array.from(m.addedNodes)) nodes.push(n);
    if (m.removedNodes) for (const n of Array.from(m.removedNodes)) nodes.push(n);
    for (const n of nodes) {
      if (!n || n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains('obf-root')) return true;
      if (n.closest && n.closest('.obf-root')) return true;
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (isOwnMutation(m)) continue;
      relevant = true;
      for (const c of controllers) {
        if (c.dirty) continue;
        if (c.host === m.target || (m.target.nodeType === 1 && c.host.contains(m.target))) {
          c.dirty = true;
        }
      }
    }
    if (!relevant) return;
    scheduleScan();
    scheduleApplyDirty();
  });

  // 诊断 / 手动挂载 API（在 DevTools 控制台使用，__obf.help() 查看说明）
  window.__obf = {
    help() {
      console.info(
        '[BOM Filter] 诊断命令:\n' +
        '  __obf.scan()            立即重新扫描页面并输出检测结果\n' +
        '  __obf.status()          查看当前已挂载的筛选栏\n' +
        '  __obf.attach(selector)  手动为指定表格/网格元素挂载筛选栏\n' +
        '  __obf.inspect()         遍历所有同源 iframe，诊断 BOM 表的真实 DOM 结构\n' +
        '  __obf.setDebug(true)    开启详细检测日志'
      );
    },
    // 诊断：遍历当前文档 + 所有同源 iframe（含 shadow DOM），
    // 找出疑似 BOM 表头文本并打印其 DOM 结构链，供开发者修正检测规则。
    inspect() {
      const KEYWORDS = ['item', 'item number', 'item no', 'quantity', 'qty',
        'part number', 'part no', 'description', 'material',
        '序号', '项目', '数量', '零件编号', '描述', '材料'];
      const out = [];

      const describe = (el) => {
        let s = el.tagName ? el.tagName.toLowerCase() : '?';
        if (el.id) s += '#' + el.id;
        if (typeof el.className === 'string' && el.className.trim()) {
          s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
        }
        return s;
      };

      const collectHits = (root) => {
        const found = [];
        (function walk(node) {
          if (found.length >= 12 || !node) return;
          if (node.nodeType === 3) {
            const raw = (node.nodeValue || '').trim();
            if (raw && raw.length <= 40) {
              const low = raw.toLowerCase();
              if (KEYWORDS.some(k => low.includes(k))) {
                const el = node.parentElement;
                if (el && !(el.closest && el.closest('.obf-root'))) {
                  const chain = [];
                  let p = el;
                  while (p && p.nodeType === 1 && chain.length < 10) {
                    chain.push(describe(p));
                    const rn = p.getRootNode ? p.getRootNode() : null;
                    p = p.parentElement || (rn && rn.host) || null;
                  }
                  found.push('  "' + raw + '"  ' + chain.join(' > '));
                }
              }
            }
            return;
          }
          if (node.nodeType !== 1 && node.nodeType !== 11) return;
          if (node.nodeType === 1) {
            const tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' ||
                tag === 'CANVAS' || tag === 'SVG') return;
            if (node.classList && node.classList.contains('obf-root')) return;
            if (node.shadowRoot) walk(node.shadowRoot);
          }
          let c = node.firstChild;
          while (c) { walk(c); c = c.nextSibling; }
        })(root);
        return found;
      };

      const scanDoc = (doc, label, depth) => {
        if (!doc || depth > 3) return;
        let body = null;
        try { body = doc.body; } catch (e) { return; }
        if (!body) return;
        let nTables = 0, nGrids = 0;
        try {
          nTables = doc.querySelectorAll('table').length;
          nGrids = doc.querySelectorAll('[role="grid"], [role="table"]').length;
        } catch (e) { /* ignore */ }
        const found = collectHits(body);
        const bomNamed = [];
        try {
          for (const el of Array.from(
            doc.querySelectorAll('[class*="bom" i], [id*="bom" i]')).slice(0, 5)) {
            bomNamed.push('  <' + describe(el) + '> ' +
              (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300));
          }
        } catch (e) { /* ignore */ }
        if (found.length || bomNamed.length || nTables || nGrids) {
          out.push('[' + label + '] tables=' + nTables +
            ', role=grid/table=' + nGrids +
            ', 疑似表头文本=' + found.length +
            ', bom命名元素=' + bomNamed.length);
          out.push(...found, ...bomNamed);
        }
        let frames = [];
        try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) { /* ignore */ }
        frames.forEach((f, i) => {
          let cd = null;
          try { cd = f.contentDocument; } catch (e) { /* 跨域 */ }
          if (cd) {
            scanDoc(cd, label + '>iframe[' + i + ']', depth + 1);
          } else {
            out.push('[' + label + '] iframe[' + i + '] 无法访问（跨域?）: ' +
              ((f.src || '').slice(0, 100) || '(无 src)'));
          }
        });
      };

      scanDoc(document, 'top', 0);
      if (!out.length) {
        out.push('未发现任何 BOM 痕迹。请确认 BOM 表已打开；' +
          '若 BOM 在跨域 iframe 中，请在 DevTools 控制台左上角框架选择器切换到对应框架后重跑 __obf.inspect()');
      }
      const text = '[BOM Filter inspect]\n' + out.join('\n');
      console.info(text);
      return text;
    },
    scan() {
      const hosts = findBomHosts();
      scan();
      console.info('[BOM Filter] 扫描完成：识别到', hosts.length,
        '个 BOM 表，当前已挂载', controllers.size, '个筛选栏');
      return hosts.map(h => h.host);
    },
    status() {
      return Array.from(controllers).map(c => c.host);
    },
    attach(selector) {
      const el = typeof selector === 'string'
        ? document.querySelector(selector) : selector;
      if (!el) {
        console.warn('[BOM Filter] 未找到元素:', selector);
        return false;
      }
      const adapter = el.tagName === 'TABLE'
        ? new HtmlTableAdapter(el) : new DivGridAdapter(el);
      try {
        controllers.add(new BomFilterController(
          el, adapter, findBomContainer(el) || el.parentElement));
        console.info('[BOM Filter] 已手动挂载筛选栏:', el);
        return true;
      } catch (e) {
        console.warn('[BOM Filter] 挂载失败:', e);
        return false;
      }
    },
    setDebug(on) {
      DEBUG = !!on;
      try {
        localStorage.setItem('obfDebug', on ? '1' : '0');
      } catch (e) { /* ignore */ }
      console.info('[BOM Filter] 详细日志已' + (on ? '开启' : '关闭'));
    }
  };

  function init() {
    console.info('[BOM Filter] 内容脚本已加载',
      window === window.top ? '(顶层页面)' : '(iframe)', location.origin);
    scan();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
