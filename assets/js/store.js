/*
 * 会话内存储：组卷配置、答题记录、历史试卷、错题本
 * 使用 sessionStorage —— 同一标签页内刷新仍在，关闭标签页即清空，不写入任何长期存储。
 * 浏览器禁用会话存储时自动退化为内存存储，不影响作答。
 */
(function (global) {
  'use strict';

  var KEY = 'medquiz.v1';
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

  /** 只在第一次使用时探测 sessionStorage，并验证真的可写（隐私模式可能抛异常） */
  function pickStorage() {
    if (storageChecked) return storage;
    storageChecked = true;
    try {
      var candidate = global.sessionStorage;
      if (!candidate) return null;
      var probe = KEY + '.probe';
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      storage = candidate;
    } catch (err) {
      storage = null;
    }
    return storage;
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
    /** 会话存储是否可用（不可用时仅本页内存有效，刷新即丢失） */
    isAvailable: function () {
      load();
      return !!pickStorage();
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
