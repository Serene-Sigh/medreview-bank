/*
 * 抽题 / 判分引擎（纯逻辑，不碰 DOM，可被 Node 直接测试）
 * 题库数据通过 QBANK.meta(...) / QBANK.bank(...) 由 data/*.js 注册进来。
 */
(function (global) {
  'use strict';

  var QBANK = {
    subjects: [],
    metas: Object.create(null),
    banks: Object.create(null),
    version: '',

    /** 读取 data/subjects.js 写入的学科列表与构建版本 */
    wire: function () {
      this.subjects = global.QBANK_SUBJECTS || [];
      this.version = global.QBANK_VERSION || '';
      return this.subjects;
    },

    meta: function (subjectId, data) {
      if (data !== undefined) {
        data.id = subjectId;
        this.metas[subjectId] = data;
      }
      return this.metas[subjectId];
    },

    bank: function (subjectId, moduleId, data) {
      var key = subjectId + '/' + moduleId;
      if (data !== undefined) this.banks[key] = data;
      return this.banks[key];
    },

    hasBank: function (subjectId, moduleId) {
      return !!this.banks[subjectId + '/' + moduleId];
    }
  };

  function shuffle(list, rng) {
    var rand = rng || Math.random;
    var arr = list.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function sample(list, count, rng) {
    if (count >= list.length) return shuffle(list, rng);
    return shuffle(list, rng).slice(0, count);
  }

  function groupBy(list, key) {
    var out = Object.create(null);
    list.forEach(function (item) {
      var k = item[key];
      (out[k] || (out[k] = [])).push(item);
    });
    return out;
  }

  /** 章节选择用 "m0/c1" 这种键 */
  function chapterKey(moduleId, chapterId) {
    return moduleId + '/' + chapterId;
  }

  var Engine = {
    shuffle: shuffle,
    sample: sample,
    chapterKey: chapterKey,

    /** 建立章节索引：{ 'm0/c1': {key, moduleId, moduleName, chapterId, chapterName, stats} } */
    chapterIndex: function (meta) {
      var index = Object.create(null);
      (meta.modules || []).forEach(function (module) {
        module.chapters.forEach(function (chapter) {
          var key = chapterKey(module.id, chapter.id);
          index[key] = {
            key: key,
            moduleId: module.id,
            moduleName: module.name,
            chapterId: chapter.id,
            chapterName: chapter.name,
            stats: chapter
          };
        });
      });
      return index;
    },

    /**
     * 按章节集合构建候选题池。
     * opts: { includeFig, onlyNew, records }
     * 返回 { pool, missingModules }
     */
    buildPool: function (subjectId, meta, chapterKeys, opts) {
      opts = opts || {};
      var index = this.chapterIndex(meta);
      var includeFig = !!opts.includeFig;
      var onlyNew = !!opts.onlyNew;
      var records = opts.records || {};
      var keys = chapterKeys && chapterKeys.length ? chapterKeys : Object.keys(index);
      var pool = [];
      var missingModules = [];
      var seen = Object.create(null);

      meta.modules.forEach(function (module) {
        var bank = QBANK.banks[subjectId + '/' + module.id];
        var wanted = module.chapters.filter(function (chapter) {
          return keys.indexOf(chapterKey(module.id, chapter.id)) >= 0;
        });
        if (!wanted.length) return;
        if (!bank) {
          missingModules.push(module.id);
          return;
        }
        wanted.forEach(function (chapter) {
          var prefix = module.id + '/' + chapter.id + '/';
          Object.keys(bank).forEach(function (qid) {
            if (seen[qid] || qid.indexOf(prefix) !== 0) return;
            var rec = bank[qid];
            if (rec.t !== 'single') return;
            var flags = rec.flags || [];
            if (flags.indexOf('dup') >= 0) return;
            if (!includeFig && flags.indexOf('fig') >= 0) return;
            if (onlyNew && records[qid]) return;
            seen[qid] = true;
            pool.push({
              qid: qid,
              sid: subjectId,
              moduleId: module.id,
              chapterId: chapter.id,
              key: chapterKey(module.id, chapter.id),
              moduleName: module.name,
              chapterName: chapter.name,
              q: rec
            });
          });
        });
      });

      return { pool: pool, missingModules: missingModules };
    },

    /** 从任意题目集合构建题池（错题重练用） */
    fromRecords: function (subjectId, meta, items) {
      var index = this.chapterIndex(meta);
      var out = [];
      items.forEach(function (item) {
        var bank = QBANK.banks[subjectId + '/' + item.moduleId];
        if (!bank) return;
        var rec = bank[item.qid];
        if (!rec || rec.t !== 'single') return;
        var meta2 = index[chapterKey(item.moduleId, item.chapterId)];
        out.push({
          qid: item.qid,
          sid: subjectId,
          moduleId: item.moduleId,
          chapterId: item.chapterId,
          key: chapterKey(item.moduleId, item.chapterId),
          moduleName: meta2 ? meta2.moduleName : '',
          chapterName: meta2 ? meta2.chapterName : '',
          q: rec
        });
      });
      return out;
    },

    /**
     * 抽题。
     * strategy: 'proportional' 按各章题量比例（等价于全池均匀随机）
     *           'even' 每章平均分配，题量不足时再随机补足
     */
    draw: function (pool, count, strategy, rng) {
      var total = pool.length;
      var want = Math.max(0, Math.min(Math.floor(count), total));
      if (want === 0) return [];
      if (strategy !== 'even') return sample(pool, want, rng);

      var groups = groupBy(pool, 'key');
      var keys = shuffle(Object.keys(groups), rng);
      var base = Math.floor(want / keys.length);
      var remain = want - base * keys.length;
      var picked = [];
      var used = Object.create(null);

      keys.forEach(function (key, i) {
        var quota = base + (i < remain ? 1 : 0);
        if (quota <= 0) return;
        var got = sample(groups[key], Math.min(quota, groups[key].length), rng);
        got.forEach(function (item) {
          picked.push(item);
          used[item.qid] = true;
        });
      });

      if (picked.length < want) {
        var rest = pool.filter(function (item) { return !used[item.qid]; });
        sample(rest, Math.min(want - picked.length, rest.length), rng).forEach(function (item) {
          picked.push(item);
        });
      }
      return shuffle(picked, rng);
    },

    /** 判分：answers 为与 entries 等长的选项字母数组，未答为空串 */
    grade: function (entries, answers) {
      var items = entries.map(function (entry, i) {
        var pick = answers[i] || '';
        var ok = !!pick && pick === entry.q.ans;
        return {
          qid: entry.qid,
          moduleId: entry.moduleId,
          chapterId: entry.chapterId,
          chapterName: entry.chapterName,
          pick: pick,
          ans: entry.q.ans,
          ok: ok
        };
      });
      var correct = 0;
      var answered = 0;
      items.forEach(function (item) {
        if (item.pick) answered++;
        if (item.ok) correct++;
      });
      var total = items.length;
      return {
        total: total,
        correct: correct,
        wrong: total - correct,
        answered: answered,
        unanswered: total - answered,
        score: correct,
        accuracy: total ? correct / total : 0,
        items: items
      };
    },

    /** 选项数组 -> [{key:'A', text:'...'}]（题库选项连续，按 A、B、C… 对应） */
    options: function (rec) {
      var opts = rec.opts || [];
      return opts.map(function (text, i) {
        return { key: 'ABCDEFG'.charAt(i), text: text };
      });
    },

    /** 统计一份试卷覆盖了哪些章节 */
    chapterSummary: function (entries) {
      var map = Object.create(null);
      entries.forEach(function (entry) {
        var name = entry.moduleName ? entry.moduleName + ' · ' + entry.chapterName : entry.chapterName;
        map[name] = (map[name] || 0) + 1;
      });
      return Object.keys(map).map(function (name) {
        return { name: name, count: map[name] };
      });
    }
  };

  global.QBANK = QBANK;
  global.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
