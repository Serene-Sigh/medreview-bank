/*
 * 记录存储：组卷配置、答题记录、历史试卷、错题本
 *
 * 两种模式：
 *   session（默认）—— sessionStorage，同一标签页刷新仍在，关闭标签页清空，不写长期存储
 *   local           —— localStorage，关浏览器也保留，清理站点数据/换设备会丢失
 * 模式偏好保存在 localStorage 的一个小键里；浏览器禁用存储时自动退化为内存，不影响作答。
 */
(function (global) {
  'use strict';

  var KEY = 'medquiz.v1';
  var MODE_KEY = 'medquiz.mode';
  var HISTORY_LIMIT = 30;

  var DEFAULT_CONFIG = {
    chapters: null,
    count: 50,
    mode: 'exam',
    strategy: 'proportional',
    includeFig: false,
    onlyNew: false
  };

  var memory = null;
  var storage = null;
  var storageChecked = false;
  var currentMode = 'session';

  function probe(store) {
    if (!store) return false;
    try {
      var probeKey = KEY + '.probe';
      store.setItem(probeKey, '1');
      store.removeItem(probeKey);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 只读取一个偏好键；读失败按 session 处理 */
  function preferredMode() {
    try {
      var ls = global.localStorage;
      return ls && ls.getItem(MODE_KEY) === 'local' ? 'local' : 'session';
    } catch (err) {
      return 'session';
    }
  }

  /**
   * 选择后端。
   * session 模式只在 sessionStorage 不可用时退化为内存；不会偷偷改成 localStorage。
   * local 模式优先 localStorage，不可用时退回 sessionStorage。
   */
  function pickStorage() {
    if (storageChecked) return storage;
    storageChecked = true;
    var candidates = preferredMode() === 'local'
      ? [['local', global.localStorage], ['session', global.sessionStorage]]
      : [['session', global.sessionStorage]];
    for (var i = 0; i < candidates.length; i++) {
      if (probe(candidates[i][1])) {
        storage = candidates[i][1];
        currentMode = candidates[i][0];
        return storage;
      }
    }
    storage = null;
    currentMode = 'session';
    return null;
  }

  function emptyState() {
    return { version: 1, config: {}, history: [], records: {} };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function load() {
    if (memory) return memory;
    var state = null;
    var store = pickStorage();
    try {
      var raw = store ? store.getItem(KEY) : null;
      if (raw) state = JSON.parse(raw);
    } catch (err) {
      storage = null;
    }
    if (!state || typeof state !== 'object') state = emptyState();
    state.config = state.config || {};
    state.history = state.history || [];
    state.records = state.records || {};
    memory = state;
    return state;
  }

  function save() {
    var store = pickStorage();
    if (!store) return;
    try {
      store.setItem(KEY, JSON.stringify(load()));
    } catch (err) {
      storage = null;
    }
  }

  var Store = {
    /** 是否能真正写盘（false 时仅本页内存有效，刷新即丢失） */
    isAvailable: function () {
      load();
      return !!pickStorage();
    },

    /** 当前生效的模式：'local' | 'session' | 'memory' */
    mode: function () {
      load();
      pickStorage();
      return storage ? currentMode : 'memory';
    },

    /** 切换存储模式，并把当前记录整体迁移到新后端 */
    setMode: function (next) {
      var wantLocal = next === 'local';
      var state = load();

      try {
        if (global.localStorage) {
          if (wantLocal) global.localStorage.setItem(MODE_KEY, 'local');
          else global.localStorage.removeItem(MODE_KEY);
        }
      } catch (err) {
        // 偏好写不进去也不影响本次切换
      }

      var previous = storage;
      storage = null;
      storageChecked = false;
      var target = pickStorage();

      if (target && target !== previous) {
        if (previous) {
          try { previous.removeItem(KEY); } catch (err) { /* 忽略 */ }
        }
        try {
          target.setItem(KEY, JSON.stringify(state));
        } catch (err) {
          storage = null;
        }
      }
      return storage ? currentMode : 'memory';
    },

    /** 导出当前全部记录（用于备份/换设备） */
    exportState: function () {
      return JSON.stringify(load(), null, 2);
    },

    /** 导入记录，成功返回 true */
    importState: function (json) {
      var parsed;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        return false;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.config || !parsed.history) return false;
      parsed.records = parsed.records || {};
      parsed.version = parsed.version || 1;
      memory = parsed;
      save();
      return true;
    },

    config: function (subjectId) {
      var state = load();
      var conf = state.config[subjectId] || {};
      var out = clone(DEFAULT_CONFIG);
      Object.keys(conf).forEach(function (k) {
        out[k] = conf[k];
      });
      return out;
    },

    saveConfig: function (subjectId, patch) {
      var state = load();
      var conf = state.config[subjectId] || clone(DEFAULT_CONFIG);
      Object.keys(patch || {}).forEach(function (k) {
        conf[k] = patch[k];
      });
      state.config[subjectId] = conf;
      save();
      return conf;
    },

    /** 记录一次作答结果，用于错题本与「只做没做过的题」 */
    recordAnswer: function (subjectId, qid, ok) {
      var state = load();
      var book = state.records[subjectId] || (state.records[subjectId] = {});
      var item = book[qid] || (book[qid] = { c: 0, w: 0, last: 0 });
      if (ok) item.c += 1;
      else item.w += 1;
      item.last = Date.now();
      save();
      return item;
    },

    records: function (subjectId) {
      return load().records[subjectId] || {};
    },

    clearRecords: function (subjectId) {
      var state = load();
      state.records[subjectId] = {};
      save();
    },

    addHistory: function (entry) {
      var state = load();
      state.history.unshift(entry);
      if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
      save();
      return entry;
    },

    history: function (subjectId) {
      var list = load().history;
      if (!subjectId) return list.slice();
      return list.filter(function (item) { return item.sid === subjectId; });
    },

    getHistory: function (id) {
      var list = load().history;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    },

    removeHistory: function (id) {
      var state = load();
      state.history = state.history.filter(function (item) { return item.id !== id; });
      save();
    },

    clearHistory: function () {
      var state = load();
      state.history = [];
      save();
    },

    /** 错题：返回 [{qid, moduleId, chapterId, w, c, last}]，按错误次数倒序 */
    wrongItems: function (subjectId) {
      var book = load().records[subjectId] || {};
      var out = [];
      Object.keys(book).forEach(function (qid) {
        var item = book[qid];
        if (!item || !item.w) return;
        var parts = qid.split('/');
        out.push({
          qid: qid,
          moduleId: parts[0],
          chapterId: parts[1],
          w: item.w,
          c: item.c,
          last: item.last || 0
        });
      });
      out.sort(function (a, b) {
        if (b.w !== a.w) return b.w - a.w;
        return b.last - a.last;
      });
      return out;
    },

    /** 已作答过的题目 id 集合（给「只做没做过的题」用） */
    answeredIds: function (subjectId) {
      var book = load().records[subjectId] || {};
      var set = Object.create(null);
      Object.keys(book).forEach(function (qid) { set[qid] = true; });
      return set;
    },

    resetAll: function () {
      memory = emptyState();
      save();
    }
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
