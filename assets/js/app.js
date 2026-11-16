/*
 * 页面逻辑：组卷 → 答题 → 判分 → 回顾，以及历史记录与错题本。
 */
(function () {
  'use strict';

  var esc = MD.escape;
  var LETTERS = 'ABCDEFG';

  var App = {
    view: 'setup',
    tab: 'setup',
    sid: '',
    meta: null,
    menuOpen: false,
    expanded: {},
    selection: {},
    config: null,
    paper: null,
    result: null,
    review: null,
    reviewSource: null,
    toastTimer: null,
    loading: 0
  };

  var timerId = null;
  var loadedScripts = Object.create(null);

  // ------------------------------------------------------------------ 工具
  function $(sel) { return document.querySelector(sel); }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function unique(list) {
    var seen = Object.create(null);
    return list.filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function toast(message) {
    var node = $('#toast');
    node.textContent = message;
    node.classList.add('is-on');
    clearTimeout(App.toastTimer);
    App.toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, 2200);
  }

  function showLoading(message) {
    App.loading += 1;
    var node = $('#loading');
    node.querySelector('.loading-text').textContent = message || '正在加载…';
    node.classList.add('is-on');
  }

  function hideLoading() {
    App.loading = Math.max(0, App.loading - 1);
    if (!App.loading) $('#loading').classList.remove('is-on');
  }

  function withLoading(message, task) {
    showLoading(message);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          resolve(task());
        } catch (err) {
          reject(err);
        }
      }, 30);
    }).then(function (value) {
      hideLoading();
      return value;
    }, function (err) {
      hideLoading();
      throw err;
    });
  }

  // -------------------------------------------------------------- 数据加载
  function loadScript(src) {
    if (loadedScripts[src]) return loadedScripts[src];
    loadedScripts[src] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () { resolve(src); };
      script.onerror = function () { reject(new Error('无法加载 ' + src)); };
      document.head.appendChild(script);
    });
    return loadedScripts[src];
  }

  function subjectEntry(sid) {
    for (var i = 0; i < QBANK.subjects.length; i++) {
      if (QBANK.subjects[i].id === sid) return QBANK.subjects[i];
    }
    return null;
  }

  function ensureSubject(sid) {
    if (QBANK.metas[sid]) return Promise.resolve(QBANK.metas[sid]);
    var entry = subjectEntry(sid);
    if (!entry) return Promise.reject(new Error('学科不存在：' + sid));
    return loadScript(entry.meta).then(function () { return QBANK.metas[sid]; });
  }

  function ensureModules(sid, moduleIds) {
    var meta = QBANK.metas[sid];
    var jobs = moduleIds.filter(function (mid) {
      return !QBANK.hasBank(sid, mid);
    }).map(function (mid) {
      var module = meta.modules.filter(function (m) { return m.id === mid; })[0];
      if (!module) return Promise.resolve();
      return loadScript(module.file);
    });
    return Promise.all(jobs);
  }

  // -------------------------------------------------------------- 配置读写
  /** 首次打开时只默认勾选「外科总论」，其余模块留给用户按需添加 */
  function defaultChapterSelection() {
    var modules = App.meta.modules || [];
    var target = null;
    for (var i = 0; i < modules.length; i++) {
      if (modules[i].name.indexOf('外科总论') >= 0) {
        target = modules[i];
        break;
      }
    }
    if (!target) target = modules[0];
    var keys = [];
    if (target) {
      target.chapters.forEach(function (chapter) {
        keys.push(target.id + '/' + chapter.id);
      });
    }
    return keys;
  }

  function loadConfig() {
    App.config = Store.config(App.sid);
    var index = Engine.chapterIndex(App.meta);
    App.selection = Object.create(null);
    var chosen = Array.isArray(App.config.chapters) ? App.config.chapters : defaultChapterSelection();
    chosen.forEach(function (key) {
      if (index[key]) App.selection[key] = true;
    });
    App.config.chapters = Object.keys(App.selection);
    App.expanded = Object.create(null);
    App.meta.modules.forEach(function (m) { App.expanded[m.id] = true; });
  }

  function persistConfig(patch) {
    Object.keys(patch || {}).forEach(function (k) {
      App.config[k] = patch[k];
    });
    Store.saveConfig(App.sid, {
      chapters: Object.keys(App.selection).filter(function (k) { return App.selection[k]; }),
      count: App.config.count,
      mode: App.config.mode,
      strategy: App.config.strategy,
      includeFig: App.config.includeFig,
      onlyNew: App.config.onlyNew
    });
  }

  function answeredPerChapter() {
    var records = Store.records(App.sid);
    var out = Object.create(null);
    Object.keys(records).forEach(function (qid) {
      var parts = qid.split('/');
      if (parts.length < 2) return;
      var key = parts[0] + '/' + parts[1];
      out[key] = (out[key] || 0) + 1;
    });
    return out;
  }

  function selectionStats() {
    var answered = App.config.onlyNew ? answeredPerChapter() : null;
    var stats = { chapters: 0, modules: 0, total: 0, available: 0, answered: 0, fig: 0, dup: 0 };
    App.meta.modules.forEach(function (module) {
      var moduleHit = false;
      module.chapters.forEach(function (chapter) {
        var key = module.id + '/' + chapter.id;
        if (!App.selection[key]) return;
        moduleHit = true;
        stats.chapters += 1;
        stats.total += chapter.single;
        stats.fig += chapter.fig || 0;
        stats.dup += chapter.dup || 0;
        var usable = App.config.includeFig
          ? (chapter.availableFig != null ? chapter.availableFig : chapter.single - (chapter.dup || 0))
          : chapter.available;
        if (answered) {
          stats.answered += answered[key] || 0;
          usable = Math.max(0, usable - (answered[key] || 0));
        }
        stats.available += usable;
      });
      if (moduleHit) stats.modules += 1;
    });
    return stats;
  }

  // ------------------------------------------------------------------ 渲染
  function render() {
    var app = $('#app');
    var html = '';
    switch (App.view) {
      case 'setup': html = renderSetup(); break;
      case 'quiz': html = renderQuiz(); break;
      case 'result': html = renderResult(); break;
      case 'review': html = renderReview(); break;
      case 'history': html = renderHistory(); break;
      case 'wrong': html = renderWrong(); break;
      default: html = renderSetup();
    }
    app.innerHTML = html;
    renderChrome();
    if (App.view === 'setup') syncCheckboxes();
    if (App.view === 'quiz') syncQuizView();
  }

  function renderChrome() {
    var tabs = [
      { id: 'setup', label: '组卷' },
      { id: 'history', label: '历史记录' },
      { id: 'wrong', label: '错题本' }
    ];
    var nav = tabs.map(function (tab) {
      var active = App.tab === tab.id;
      return '<button class="tab' + (active ? ' is-active' : '') + '" data-act="nav" data-view="' + tab.id + '">' +
        tab.label + '</button>';
    }).join('');

    var current = subjectEntry(App.sid);
    var items = QBANK.subjects.map(function (subject) {
      var active = subject.id === App.sid;
      return '<button class="subject-item' + (active ? ' is-active' : '') + '"' +
        ' role="menuitemradio" aria-checked="' + (active ? 'true' : 'false') + '"' +
        ' data-act="subject" data-sid="' + esc(subject.id) + '">' +
        '<span class="subject-check">' + (active ? '✓' : '') + '</span>' +
        '<span class="subject-name">' + esc(subject.name) + '</span>' +
        '<span class="subject-count">' + fmt(subject.questions) + ' 题</span>' +
        '</button>';
    }).join('');

    var switcher = '<div class="subject-switch' + (App.menuOpen ? ' is-open' : '') + '">' +
      '<button class="subject-trigger" data-act="subject-menu" aria-haspopup="menu" aria-expanded="' +
        (App.menuOpen ? 'true' : 'false') + '" aria-label="切换学科">' +
        '<span class="subject-label">学科</span>' +
        '<span class="subject-current">' + esc(current ? current.name : '') + '</span>' +
        '<span class="subject-caret">▾</span>' +
      '</button>' +
      (App.menuOpen
        ? '<div class="subject-menu" role="menu" aria-label="选择学科">' + items + '</div>'
        : '') +
      '</div>';

    $('#chrome-nav').innerHTML = nav;
    $('#chrome-subjects').innerHTML = switcher;

    // 遮罩放在 body 层，避免被顶栏的 backdrop-filter 限制成只覆盖顶栏
    var overlay = document.getElementById ? document.getElementById('subject-overlay') : null;
    if (overlay) {
      overlay.className = 'subject-backdrop' + (App.menuOpen ? ' is-on' : '');
    }
  }

  /** 切换学科：载入元数据、恢复该学科的组卷配置 */
  function switchSubject(sid) {
    App.menuOpen = false;
    return ensureSubject(sid).then(function () {
      App.sid = sid;
      App.meta = QBANK.metas[sid];
      loadConfig();
      App.tab = 'setup';
      App.view = 'setup';
      App.result = null;
      App.review = null;
      App.reviewSource = null;
      render();
    }).catch(function (err) { toast(err.message); });
  }

  function focusMenuItem() {
    var node = document.querySelector('.subject-item.is-active') || document.querySelector('.subject-item');
    if (node && node.focus) node.focus();
  }

  function focusSubjectTrigger() {
    var node = document.querySelector('.subject-trigger');
    if (node && node.focus) node.focus();
  }

  /** 菜单展开时用上下键在学科之间移动焦点 */
  function moveMenuFocus(step) {
    var items = [].slice.call(document.querySelectorAll('.subject-item'));
    if (!items.length) return;
    var index = items.indexOf(document.activeElement);
    var next = index < 0 ? 0 : (index + step + items.length) % items.length;
    if (items[next] && items[next].focus) items[next].focus();
  }

  // ------------------------------------------------------------- 组卷页
  function renderSetup() {
    var stats = selectionStats();
    var storeLocal = Store.mode() === 'local';
    var target = Math.min(App.config.count, stats.available);
    var modulesHtml = App.meta.modules.map(function (module) {
      var picked = 0;
      var usable = 0;
      module.chapters.forEach(function (chapter) {
        if (App.selection[module.id + '/' + chapter.id]) picked += 1;
        usable += chapter.available;
      });
      var state = picked === 0 ? 'none' : (picked === module.chapters.length ? 'all' : 'some');
      var open = App.expanded[module.id];
      var chips = module.chapters.map(function (chapter) {
        var key = module.id + '/' + chapter.id;
        var on = !!App.selection[key];
        return '<button class="chip' + (on ? ' is-on' : '') + '" data-act="chapter" data-key="' + key + '">' +
          '<span class="chip-name">' + esc(chapter.name) + '</span>' +
          '<span class="chip-count">' + chapter.available + '</span>' +
          '</button>';
      }).join('');

      return '<section class="module' + (open ? ' is-open' : '') + '">' +
        '<header class="module-head">' +
          '<button class="tick" data-act="module" data-mod="' + module.id + '" data-state="' + state + '" aria-label="选择整个模块"></button>' +
          '<button class="module-title" data-act="expand" data-mod="' + module.id + '">' +
            '<span class="module-name">' + esc(module.name) + '</span>' +
            '<span class="module-meta">' + module.chapters.length + ' 章 · 可抽 ' + fmt(usable) + ' 题</span>' +
          '</button>' +
          '<span class="module-chev">' + (open ? '−' : '+') + '</span>' +
        '</header>' +
        '<div class="chapters">' + chips + '</div>' +
      '</section>';
    }).join('');

    var countButtons = [25, 50, 100].map(function (n) {
      return '<button class="pill' + (App.config.count === n ? ' is-on' : '') + '" data-act="count" data-n="' + n + '">' + n + ' 题</button>';
    }).join('');

    var modeExam = App.config.mode === 'exam';
    var strategyProportional = App.config.strategy === 'proportional';

    return '' +
      '<div class="setup">' +
        '<section class="panel panel-range">' +
          '<div class="panel-head">' +
            '<h2>选择范围</h2>' +
            '<div class="bulk">' +
              '<button class="ghost" data-act="select-all">全选</button>' +
              '<button class="ghost" data-act="select-none">全不选</button>' +
              '<button class="ghost" data-act="select-invert">反选</button>' +
            '</div>' +
          '</div>' +
          '<p class="panel-note">已选 <b>' + stats.chapters + '</b> / ' + App.meta.stats.chapters +
            ' 个章节，覆盖 <b>' + stats.modules + '</b> 个模块。括号内数字为该章可抽题数。</p>' +
          '<div class="modules">' + modulesHtml + '</div>' +
        '</section>' +

        '<aside class="panel panel-side">' +
          '<h2>试卷设置</h2>' +
          '<div class="field">' +
            '<label class="field-label">题量</label>' +
            '<div class="pills">' + countButtons + '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-label">模式</label>' +
            '<div class="choice-list">' +
              '<button class="choice' + (modeExam ? ' is-on' : '') + '" data-act="mode" data-mode="exam">' +
                '<b>考试模式</b><span>全部答完交卷后统一看答案与解析</span></button>' +
              '<button class="choice' + (!modeExam ? ' is-on' : '') + '" data-act="mode" data-mode="practice">' +
                '<b>练习模式</b><span>选中选项后立即判对错并显示解析</span></button>' +
            '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-label">抽题方式</label>' +
            '<div class="pills">' +
              '<button class="pill' + (strategyProportional ? ' is-on' : '') + '" data-act="strategy" data-strategy="proportional">按章节比例</button>' +
              '<button class="pill' + (!strategyProportional ? ' is-on' : '') + '" data-act="strategy" data-strategy="even">每章平均</button>' +
            '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-label">记录保存</label>' +
            '<button class="switch' + (storeLocal ? ' is-on' : '') + '" data-act="toggle-store">' +
              '<span class="switch-dot"></span><span>在本机长期保存（关闭则关闭标签页即清空）</span></button>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-label">高级</label>' +
            '<button class="switch' + (App.config.includeFig ? ' is-on' : '') + '" data-act="toggle-fig">' +
              '<span class="switch-dot"></span><span>包含缺图题（默认排除 ' + stats.fig + ' 题）</span></button>' +
            '<button class="switch' + (App.config.onlyNew ? ' is-on' : '') + '" data-act="toggle-onlynew">' +
              '<span class="switch-dot"></span><span>只做没做过的题</span></button>' +
          '</div>' +
          '<div class="summary">' +
            '<div class="summary-row"><span>可用题量</span><b>' + fmt(stats.available) + '</b></div>' +
            '<div class="summary-row"><span>本卷题量</span><b>' + target + '</b></div>' +
            (target < App.config.count ? '<p class="summary-warn">题量不足 ' + App.config.count +
              ' 题，按可用题量出卷</p>' : '') +
          '</div>' +
          '<button class="primary-btn" data-act="start"' + (stats.available ? '' : ' disabled') + '>开始答题</button>' +
          '<p class="side-foot">' + (storeLocal
            ? '记录保存在本机浏览器，清理缓存或换设备会丢失。'
            : '记录只在当前标签页内有效，关闭标签页后自动清空。') + '</p>' +
        '</aside>' +
      '</div>';
  }

  function syncCheckboxes() {
    App.meta.modules.forEach(function (module) {
      var picked = module.chapters.filter(function (chapter) {
        return App.selection[module.id + '/' + chapter.id];
      }).length;
      var state = picked === 0 ? 'none' : (picked === module.chapters.length ? 'all' : 'some');
      var tick = document.querySelector('.tick[data-mod="' + module.id + '"]');
      if (tick) tick.setAttribute('data-state', state);
    });
  }

  // ------------------------------------------------------------- 答题页
  function renderQuiz() {
    var paper = App.paper;
    var entry = paper.entries[paper.index];
    var pick = paper.answers[paper.index] || '';
    var revealed = paper.mode === 'practice' && paper.revealed[paper.index];
    var options = Engine.options(entry.q);
    var flags = entry.q.flags || [];

    var optionHtml = options.map(function (option, i) {
      var cls = 'opt';
      if (pick === option.key) cls += ' is-picked';
      if (revealed) {
        if (option.key === entry.q.ans) cls += ' is-correct';
        else if (option.key === pick) cls += ' is-wrong';
      }
      var mark = '';
      if (revealed && option.key === entry.q.ans) mark = '<span class="opt-mark ok">正确答案</span>';
      else if (revealed && option.key === pick) mark = '<span class="opt-mark bad">你的选择</span>';
      return '<button class="' + cls + '" data-act="pick" data-i="' + i + '" data-key="' + option.key + '"' +
        (revealed ? ' disabled' : '') + '>' +
        '<span class="opt-key">' + option.key + '</span>' +
        '<span class="opt-text">' + esc(option.text) + '</span>' + mark +
        '</button>';
    }).join('');

    var navHtml = paper.entries.map(function (item, i) {
      var cls = 'nav-cell';
      if (i === paper.index) cls += ' is-current';
      if (paper.answers[i]) cls += ' is-done';
      if (paper.marked[i]) cls += ' is-marked';
      if (paper.mode === 'practice' && paper.revealed[i]) {
        cls += paper.answers[i] === item.q.ans ? ' is-ok' : ' is-bad';
      }
      return '<button class="' + cls + '" data-act="goto" data-i="' + i + '">' + (i + 1) + '</button>';
    }).join('');

    var answered = paper.answers.filter(Boolean).length;

    var feedback = '';
    if (revealed) {
      var ok = pick === entry.q.ans;
      feedback = '<div class="feedback ' + (ok ? 'ok' : 'bad') + '">' +
        '<div class="feedback-head">' + (ok ? '回答正确' : '回答错误') +
          '<span class="feedback-ans">正确答案 ' + entry.q.ans + '</span></div>' +
        '<div class="explain">' + renderExplanation(entry.q) + '</div>' +
        '</div>';
    }

    var badges = '';
    if (flags.indexOf('fig') >= 0) badges += '<span class="badge warn">本题缺图</span>';
    if (flags.indexOf('checked') >= 0) badges += '<span class="badge">答案经复核</span>';

    return '' +
      '<div class="quiz">' +
        '<div class="quizbar">' +
          '<button class="ghost" data-act="exit">‹ 退出</button>' +
          '<div class="quizbar-title">' +
            '<b>' + esc(subjectName(App.sid)) + '</b>' +
            '<span>' + (paper.mode === 'exam' ? '考试模式' : '练习模式') + '</span>' +
          '</div>' +
          '<div class="quizbar-right">' +
            '<span class="timer" id="timer">' + fmtTime(paper.elapsed || 0) + '</span>' +
            '<span class="progress-text">已答 ' + answered + '/' + paper.entries.length + '</span>' +
            '<button class="primary-btn small" data-act="submit">' + (paper.mode === 'exam' ? '交卷' : '结束练习') + '</button>' +
          '</div>' +
        '</div>' +

        '<div class="quiz-body">' +
          '<div class="qcard">' +
            '<div class="qcard-head">' +
              '<span class="qindex">第 ' + (paper.index + 1) + ' 题 <em>/ 共 ' + paper.entries.length + ' 题</em></span>' +
              '<span class="tag">' + esc(entry.chapterName) + '</span>' +
              badges +
              '<button class="mark-btn' + (paper.marked[paper.index] ? ' is-on' : '') + '" data-act="mark">' +
                (paper.marked[paper.index] ? '已标记' : '标记') + '</button>' +
            '</div>' +
            '<div class="stem">' + esc(entry.q.stem) + '</div>' +
            '<div class="options">' + optionHtml + '</div>' +
            feedback +
            '<div class="qcard-foot">' +
              '<button class="ghost" data-act="prev"' + (paper.index === 0 ? ' disabled' : '') + '>上一题</button>' +
              (revealed
                ? '<button class="primary-btn" data-act="next">' + (paper.index === paper.entries.length - 1 ? '完成练习' : '下一题') + '</button>'
                : '<button class="primary-btn" data-act="next"' + (paper.index === paper.entries.length - 1 ? ' disabled' : '') + '>下一题</button>') +
            '</div>' +
          '</div>' +

          '<aside class="navpanel">' +
            '<h3>答题卡</h3>' +
            '<div class="navgrid">' + navHtml + '</div>' +
            '<div class="legend">' +
              '<span><i class="dot done"></i>已答</span>' +
              '<span><i class="dot current"></i>当前</span>' +
              '<span><i class="dot marked"></i>标记</span>' +
            '</div>' +
            '<button class="ghost block" data-act="submit">' + (paper.mode === 'exam' ? '交卷并看成绩' : '结束练习') + '</button>' +
          '</aside>' +
        '</div>' +
      '</div>';
  }

  function syncQuizView() {
    var paper = App.paper;
    if (!paper) return;
    var timer = $('#timer');
    if (timer) timer.textContent = fmtTime(paper.elapsed || 0);
  }

  function startTimer() {
    stopTimer();
    var paper = App.paper;
    paper.elapsed = 0;
    timerId = setInterval(function () {
      if (!App.paper || App.view !== 'quiz') return;
      App.paper.elapsed = Math.round((Date.now() - App.paper.startedAt) / 1000);
      var timer = $('#timer');
      if (timer) timer.textContent = fmtTime(App.paper.elapsed);
    }, 500);
  }

  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function renderExplanation(rec) {
    var text = (rec.exp || '').replace(/^\s*正确答案是\s*[A-G]\s*[。.．]?\s*/, '');
    if (!text.replace(/\s/g, '')) {
      return '<p class="muted">本题暂无解析。</p>';
    }
    return MD.render(text);
  }

  function subjectName(sid) {
    var entry = subjectEntry(sid);
    return entry ? entry.name : sid;
  }

  // ------------------------------------------------------------- 成绩页
  function renderResult() {
    var result = App.result;
    var grade = result.grade;
    var pct = Math.round(grade.accuracy * 100);
    var circumference = 2 * Math.PI * 52;
    var dash = (pct / 100) * circumference;

    var breakdown = Engine.chapterSummary(result.entries).map(function (row) {
      var hit = 0;
      result.entries.forEach(function (entry, i) {
        var name = entry.moduleName ? entry.moduleName + ' · ' + entry.chapterName : entry.chapterName;
        if (name === row.name && grade.items[i].ok) hit += 1;
      });
      var rate = row.count ? Math.round(hit / row.count * 100) : 0;
      return '<div class="bd-row">' +
        '<span class="bd-name">' + esc(row.name) + '</span>' +
        '<span class="bd-bar"><i style="width:' + rate + '%"></i></span>' +
        '<span class="bd-num">' + hit + '/' + row.count + '</span>' +
        '</div>';
    }).join('');

    return '' +
      '<div class="result">' +
        '<section class="panel result-card">' +
          '<div class="ring-wrap">' +
            '<svg viewBox="0 0 120 120" class="ring">' +
              '<circle cx="60" cy="60" r="52" class="ring-bg"></circle>' +
              '<circle cx="60" cy="60" r="52" class="ring-fg" style="stroke-dasharray:' + dash.toFixed(1) + ' ' + circumference.toFixed(1) + '"></circle>' +
            '</svg>' +
            '<div class="ring-label"><b>' + pct + '<i>%</i></b><span>正确率</span></div>' +
          '</div>' +
          '<div class="result-main">' +
            '<h1>本次得分 <b>' + grade.correct + '</b><span>/ ' + grade.total + '</span></h1>' +
            '<div class="result-meta">' +
              '<span>答对 <b class="ok">' + grade.correct + '</b> 题</span>' +
              '<span>答错 <b class="bad">' + grade.wrong + '</b> 题</span>' +
              '<span>未答 <b>' + grade.unanswered + '</b> 题</span>' +
              '<span>用时 <b>' + fmtTime(result.entry.elapsed) + '</b></span>' +
              '<span>' + (result.entry.mode === 'exam' ? '考试模式' : '练习模式') + '</span>' +
            '</div>' +
            '<div class="result-actions">' +
              '<button class="primary-btn" data-act="open-review">查看回顾与解析</button>' +
              '<button class="ghost" data-act="retry-wrong"' + (grade.wrong ? '' : ' disabled') + '>用错题再练</button>' +
              '<button class="ghost" data-act="restart">再组一份</button>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="panel">' +
          '<h2>章节表现</h2>' +
          '<div class="breakdown">' + (breakdown || '<p class="muted">暂无数据</p>') + '</div>' +
        '</section>' +
      '</div>';
  }

  // ------------------------------------------------------------- 回顾页
  function renderReview() {
    var review = App.review;
    if (!review) return renderSetup();
    var grade = review.grade;
    var filter = review.filter || 'all';
    var counts = { all: review.entries.length, wrong: grade.wrong, unanswered: grade.unanswered };

    var rows = review.entries.map(function (entry, i) {
      var item = grade.items[i];
      var hidden = filter === 'wrong' && item.ok;
      if (filter === 'unanswered' && item.pick) hidden = true;
      if (hidden) return '';

      var options = Engine.options(entry.q);
      var flags = entry.q.flags || [];
      var optionHtml = options.map(function (option) {
        var cls = 'opt review';
        if (option.key === entry.q.ans) cls += ' is-correct';
        if (item.pick === option.key && !item.ok) cls += ' is-wrong';
        return '<div class="' + cls + '">' +
          '<span class="opt-key">' + option.key + '</span>' +
          '<span class="opt-text">' + esc(option.text) + '</span>' +
          (option.key === entry.q.ans ? '<span class="opt-mark ok">正确</span>' : '') +
          (item.pick === option.key && !item.ok ? '<span class="opt-mark bad">你的选择</span>' : '') +
          '</div>';
      }).join('');

      var badge = item.ok ? '<span class="badge ok">答对</span>'
        : (item.pick ? '<span class="badge bad">答错</span>' : '<span class="badge">未作答</span>');
      var extra = '';
      if (flags.indexOf('fig') >= 0) extra += '<span class="badge warn">本题缺图</span>';
      if (flags.indexOf('checked') >= 0) extra += '<span class="badge">答案经复核</span>';

      return '<article class="review-card" id="q-' + esc(entry.qid) + '">' +
        '<header class="review-head">' +
          '<span class="qnum">' + (i + 1) + '</span>' +
          '<span class="tag">' + esc(entry.chapterName) + '</span>' +
          badge + extra +
        '</header>' +
        '<div class="stem">' + esc(entry.q.stem) + '</div>' +
        '<div class="options review-list">' + optionHtml + '</div>' +
        '<div class="answerline">' +
          '<span>正确答案 <b class="ok">' + entry.q.ans + '</b></span>' +
          '<span>你的答案 <b class="' + (item.ok ? 'ok' : 'bad') + '">' + (item.pick || '未作答') + '</b></span>' +
        '</div>' +
        '<div class="explain"><h4 class="explain-title">解析</h4>' + renderExplanation(entry.q) + '</div>' +
        '</article>';
    }).join('');

    return '' +
      '<div class="review">' +
        '<section class="panel review-top">' +
          '<div class="review-top-main">' +
            '<h1>' + grade.correct + ' / ' + grade.total + ' <span class="muted">正确率 ' + Math.round(grade.accuracy * 100) + '%</span></h1>' +
            '<p class="muted">' + esc(review.title || '本次试卷') + ' · 用时 ' + fmtTime(review.elapsed || 0) + '</p>' +
          '</div>' +
          '<div class="result-actions">' +
            '<button class="ghost" data-act="retry-wrong"' + (grade.wrong ? '' : ' disabled') + '>用错题再练</button>' +
            '<button class="ghost" data-act="restart">再组一份</button>' +
            '<button class="ghost" data-act="nav" data-view="history">历史记录</button>' +
          '</div>' +
        '</section>' +
        '<div class="filterbar">' +
          '<button class="filter' + (filter === 'all' ? ' is-on' : '') + '" data-act="filter" data-filter="all">全部 ' + counts.all + '</button>' +
          '<button class="filter' + (filter === 'wrong' ? ' is-on' : '') + '" data-act="filter" data-filter="wrong">错题 ' + counts.wrong + '</button>' +
          '<button class="filter' + (filter === 'unanswered' ? ' is-on' : '') + '" data-act="filter" data-filter="unanswered">未答 ' + counts.unanswered + '</button>' +
        '</div>' +
        '<div class="review-list-wrap">' + (rows || '<p class="muted empty">没有符合条件的题目</p>') + '</div>' +
      '</div>';
  }

  // ------------------------------------------------------------- 历史页
  function exportRecords() {
    var stamp = new Date();
    var name = '刷题记录_' + stamp.getFullYear() + pad2(stamp.getMonth() + 1) + pad2(stamp.getDate()) +
      '_' + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + '.json';
    try {
      var blob = new Blob([Store.exportState()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('已导出 ' + name);
    } catch (err) {
      toast('导出失败：' + (err.message || err));
    }
  }

  function importRecords() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        if (Store.importState(String(reader.result))) {
          loadConfig();
          toast('记录已导入');
          render();
        } else {
          toast('文件格式不对，导入失败');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function renderHistory() {
    var list = Store.history();
    var modeLabel = Store.mode() === 'local' ? '本机长期保存' : '仅当前标签页';
    if (!list.length) {
      return '<section class="panel empty-panel"><h2>历史记录</h2>' +
        '<p class="muted">还没有完成过试卷。做完一份后，成绩和每道题的作答都会保存在这里。</p>' +
        '<div class="result-actions" style="justify-content:center">' +
          '<button class="primary-btn" data-act="nav" data-view="setup">去组卷</button>' +
          '<button class="ghost" data-act="import-records">导入记录</button>' +
        '</div></section>';
    }
    var rows = list.map(function (item) {
      var pct = item.count ? Math.round(item.correct / item.count * 100) : 0;
      var subjectLabel = item.sname || subjectName(item.sid);
      return '<div class="history-row">' +
        '<div class="h-main">' +
          '<div class="h-title">' + item.correct + ' / ' + item.count + ' 题' +
            '<span class="h-pct">' + pct + '%</span>' +
            '<span class="tag h-tag">' + esc(subjectLabel) + '</span></div>' +
          '<div class="h-meta">' + fmtDate(item.at) + ' · 用时 ' + fmtTime(item.elapsed) +
            ' · ' + (item.mode === 'exam' ? '考试' : '练习') + '</div>' +
        '</div>' +
        '<div class="h-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="h-actions">' +
          '<button class="ghost small" data-act="history-open" data-id="' + esc(item.id) + '">回顾</button>' +
          '<button class="ghost small danger" data-act="history-del" data-id="' + esc(item.id) + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<section class="panel">' +
      '<div class="panel-head"><h2>历史记录</h2>' +
        '<div class="bulk">' +
          '<button class="ghost small" data-act="export-records">导出记录</button>' +
          '<button class="ghost small" data-act="import-records">导入记录</button>' +
          '<button class="ghost small danger" data-act="history-clear">清空记录</button>' +
        '</div>' +
      '</div>' +
      '<p class="panel-note">所有学科的试卷都在这里，共 ' + list.length +
        ' 条（最多保留 30 条），当前保存方式：<b>' + modeLabel + '</b>。' +
        '点「回顾」会切换到对应学科看当次题目；「导出记录」可把成绩与错题存成 JSON 备份。</p>' +
      '<div class="history-list">' + rows + '</div>' +
      '</section>';
  }

  // ------------------------------------------------------------- 错题本
  function openWrong() {
    var items = Store.wrongItems(App.sid);
    App.tab = 'wrong';
    App.wrongLimit = 50;
    if (!items.length) {
      App.view = 'wrong';
      render();
      return;
    }
    var moduleIds = unique(items.map(function (item) { return item.moduleId; }));
    withLoading('正在加载错题…', function () {
      return ensureModules(App.sid, moduleIds);
    }).then(function () {
      App.view = 'wrong';
      render();
    }).catch(function (err) {
      toast(err.message || '错题加载失败');
    });
  }

  function renderWrong() {
    var items = Store.wrongItems(App.sid);
    if (!items.length) {
      return '<section class="panel empty-panel"><h2>错题本</h2>' +
        '<p class="muted">还没有错题。答错过的题目会自动收进这里，可以反复重练。</p>' +
        '<button class="primary-btn" data-act="nav" data-view="setup">去组卷</button></section>';
    }

    var index = Engine.chapterIndex(App.meta);
    var limit = App.wrongLimit || 50;
    var flat = [];
    items.forEach(function (item) {
      var bank = QBANK.banks[App.sid + '/' + item.moduleId];
      if (!bank || !bank[item.qid]) return;
      var key = item.moduleId + '/' + item.chapterId;
      flat.push({
        key: key,
        name: index[key] ? index[key].moduleName + ' · ' + index[key].chapterName : key,
        rec: bank[item.qid],
        item: item
      });
    });

    var shown = flat.slice(0, limit);
    var groups = Object.create(null);
    var order = [];
    shown.forEach(function (row) {
      if (!groups[row.key]) {
        groups[row.key] = { name: row.name, rows: [] };
        order.push(row.key);
      }
      groups[row.key].rows.push(row);
    });

    var groupsHtml = order.map(function (key) {
      var group = groups[key];
      var rows = group.rows.map(function (row) {
        var rec = row.rec;
        var stem = rec.stem.length > 90 ? rec.stem.slice(0, 90) + '…' : rec.stem;
        return '<details class="wrong-item">' +
          '<summary>' +
            '<span class="w-stem">' + esc(stem) + '</span>' +
            '<span class="w-badge">错 ' + row.item.w + ' 次</span>' +
            '<span class="w-ans">答案 ' + rec.ans + '</span>' +
          '</summary>' +
          '<div class="w-body">' +
            '<div class="options review-list">' + Engine.options(rec).map(function (option) {
              var cls = 'opt review' + (option.key === rec.ans ? ' is-correct' : '');
              return '<div class="' + cls + '"><span class="opt-key">' + option.key + '</span>' +
                '<span class="opt-text">' + esc(option.text) + '</span></div>';
            }).join('') + '</div>' +
            '<div class="explain"><h4 class="explain-title">解析</h4>' + renderExplanation(rec) + '</div>' +
          '</div>' +
        '</details>';
      }).join('');
      return '<section class="wrong-group">' +
        '<h3>' + esc(group.name) + '<span class="muted"> 共 ' + group.rows.length + ' 题</span></h3>' +
        rows + '</section>';
    }).join('');

    var more = flat.length > shown.length
      ? '<button class="ghost block" data-act="wrong-more">显示更多（还有 ' + (flat.length - shown.length) + ' 题）</button>'
      : '';

    return '<section class="panel">' +
      '<div class="panel-head"><h2>错题本</h2>' +
        '<div class="bulk">' +
          '<button class="ghost small" data-act="wrong-quiz" data-n="25">抽 25 题重练</button>' +
          '<button class="ghost small" data-act="wrong-quiz" data-n="50">抽 50 题重练</button>' +
          '<button class="ghost small danger" data-act="wrong-clear">清空错题本</button>' +
        '</div>' +
      '</div>' +
      '<p class="panel-note">共 <b>' + items.length + '</b> 道错题，按错误次数排序；点开可看答案与解析。</p>' +
      '<div class="wrong-list">' + groupsHtml + '</div>' + more +
      '</section>';
  }

  // ------------------------------------------------------------- 流程控制
  function startPaper() {
    var keys = Object.keys(App.selection).filter(function (k) { return App.selection[k]; });
    if (!keys.length) { toast('请至少选择一个章节'); return; }
    var conf = App.config;
    var moduleIds = unique(keys.map(function (k) { return k.split('/')[0]; }));

    withLoading('正在加载题目…', function () {
      return ensureModules(App.sid, moduleIds);
    }).then(function () {
      var built = Engine.buildPool(App.sid, App.meta, keys, {
        includeFig: conf.includeFig,
        onlyNew: conf.onlyNew,
        records: Store.records(App.sid)
      });
      if (built.missingModules.length) {
        toast('部分模块加载失败，已跳过');
      }
      if (!built.pool.length) {
        toast('所选范围没有可用题目');
        return;
      }
      App.paper = {
        entries: Engine.draw(built.pool, conf.count, conf.strategy),
        answers: [],
        marked: Object.create(null),
        revealed: Object.create(null),
        index: 0,
        mode: conf.mode,
        startedAt: Date.now(),
        elapsed: 0,
        config: {
          count: conf.count,
          mode: conf.mode,
          strategy: conf.strategy,
          includeFig: conf.includeFig,
          onlyNew: conf.onlyNew
        }
      };
      App.paper.answers = App.paper.entries.map(function () { return ''; });
      App.tab = 'setup';
      App.view = 'quiz';
      App.reviewSource = null;
      App.result = null;
      App.review = null;
      render();
      startTimer();
    }).catch(function (err) {
      toast(err.message || '题目加载失败');
    });
  }

  function startWrongPaper(count) {
    var items = Store.wrongItems(App.sid);
    if (!items.length) { toast('错题本是空的'); return; }
    var chosen = items.slice(0, Math.min(count || items.length, items.length));
    var moduleIds = unique(chosen.map(function (item) { return item.moduleId; }));

    withLoading('正在加载题目…', function () {
      return ensureModules(App.sid, moduleIds);
    }).then(function () {
      var pool = Engine.fromRecords(App.sid, App.meta, chosen);
      if (!pool.length) { toast('错题对应的题目已不在题库中'); return; }
      App.paper = {
        entries: Engine.shuffle(pool),
        answers: pool.map(function () { return ''; }),
        marked: Object.create(null),
        revealed: Object.create(null),
        index: 0,
        mode: 'exam',
        startedAt: Date.now(),
        elapsed: 0,
        config: { count: pool.length, mode: 'exam', strategy: 'wrong', includeFig: true, onlyNew: false }
      };
      App.tab = 'wrong';
      App.view = 'quiz';
      render();
      startTimer();
    }).catch(function (err) { toast(err.message || '加载失败'); });
  }

  function submitPaper() {
    var paper = App.paper;
    if (!paper) return;
    var unanswered = paper.answers.filter(function (a) { return !a; }).length;
    if (paper.mode === 'exam' && unanswered > 0) {
      openModal(
        '确认交卷？',
        '还有 ' + unanswered + ' 道题没有作答，未作答的题目按答错计分。',
        '交卷',
        finishPaper
      );
      return;
    }
    finishPaper();
  }

  function finishPaper() {
    closeModal();
    stopTimer();
    var paper = App.paper;
    var grade = Engine.grade(paper.entries, paper.answers);

    paper.entries.forEach(function (entry, i) {
      var pick = paper.answers[i];
      if (!pick) return;
      // 练习模式在选中时已记录，避免重复计数
      if (paper.mode === 'practice') return;
      Store.recordAnswer(App.sid, entry.qid, pick === entry.q.ans);
    });

    var entry = {
      id: 'h' + Date.now(),
      sid: App.sid,
      sname: subjectName(App.sid),
      at: Date.now(),
      elapsed: Math.round((Date.now() - paper.startedAt) / 1000),
      count: paper.entries.length,
      correct: grade.correct,
      mode: paper.mode,
      strategy: paper.config.strategy,
      items: grade.items.map(function (item) {
        return {
          qid: item.qid,
          moduleId: item.moduleId,
          chapterId: item.chapterId,
          pick: item.pick,
          ok: item.ok
        };
      })
    };
    Store.addHistory(entry);

    App.result = { grade: grade, entry: entry, entries: paper.entries };
    App.paper = null;
    App.view = 'result';
    render();
  }

  function openReview() {
    var result = App.result;
    if (!result) return;
    App.review = {
      entries: result.entries,
      grade: result.grade,
      filter: 'all',
      elapsed: result.entry.elapsed,
      title: subjectName(result.entry.sid) + ' · ' + result.entry.count + ' 题',
      source: 'result'
    };
    App.reviewSource = 'result';
    App.tab = 'setup';
    App.view = 'review';
    render();
  }

  function openHistoryReview(id) {
    var entry = Store.getHistory(id);
    if (!entry) { toast('这条记录已不存在'); return; }
    var moduleIds = unique(entry.items.map(function (item) { return item.moduleId; }));
    withLoading('正在加载题目…', function () {
      return ensureSubject(entry.sid).then(function () {
        if (entry.sid !== App.sid) {
          App.sid = entry.sid;
          App.meta = QBANK.metas[entry.sid];
          loadConfig();
        }
        return ensureModules(entry.sid, moduleIds);
      });
    }).then(function () {
      var bank = null;
      var entries = [];
      entry.items.forEach(function (item) {
        bank = QBANK.banks[entry.sid + '/' + item.moduleId];
        if (!bank) return;
        var rec = bank[item.qid];
        if (!rec) return;
        var chapter = null;
        App.meta.modules.forEach(function (module) {
          if (module.id !== item.moduleId) return;
          module.chapters.forEach(function (ch) {
            if (ch.id === item.chapterId) chapter = ch;
          });
        });
        entries.push({
          qid: item.qid,
          sid: entry.sid,
          moduleId: item.moduleId,
          chapterId: item.chapterId,
          key: item.moduleId + '/' + item.chapterId,
          moduleName: '',
          chapterName: chapter ? chapter.name : item.chapterId,
          q: rec
        });
      });
      var answers = entry.items.map(function (item) { return item.pick || ''; });
      var grade = Engine.grade(entries, answers);
      App.review = {
        entries: entries,
        grade: grade,
        filter: 'all',
        elapsed: entry.elapsed,
        title: subjectName(entry.sid) + ' · ' + fmtDate(entry.at),
        source: 'history'
      };
      App.reviewSource = 'history';
      App.tab = 'history';
      App.view = 'review';
      App.result = null;
      render();
    }).catch(function (err) { toast(err.message || '加载失败'); });
  }

  // ------------------------------------------------------------- 弹窗
  function openModal(title, message, confirmText, onConfirm) {
    var modal = $('#modal');
    modal.innerHTML = '<div class="modal-card">' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(message) + '</p>' +
      '<div class="modal-actions">' +
        '<button class="ghost" data-act="modal-cancel">再想想</button>' +
        '<button class="primary-btn" data-act="modal-confirm">' + esc(confirmText) + '</button>' +
      '</div>' +
      '</div>';
    modal.classList.add('is-on');
    App.modalConfirm = onConfirm;
  }

  function closeModal() {
    var modal = $('#modal');
    modal.classList.remove('is-on');
    modal.innerHTML = '';
    App.modalConfirm = null;
  }

  // ------------------------------------------------------------- 交互
  function onSelectAll(mode) {
    var index = Engine.chapterIndex(App.meta);
    var keys = Object.keys(index);
    if (mode === 'all') {
      keys.forEach(function (k) { App.selection[k] = true; });
    } else if (mode === 'none') {
      App.selection = Object.create(null);
    } else {
      keys.forEach(function (k) { App.selection[k] = !App.selection[k]; });
    }
    persistConfig();
    render();
  }

  function handleClick(event) {
    var target = event.target.closest('[data-act]');
    if (!target) return;
    var act = target.getAttribute('data-act');

    switch (act) {
      case 'nav':
        var view = target.getAttribute('data-view');
        App.menuOpen = false;
        if (App.view === 'quiz' && App.paper) {
          openModal('退出本次答题？', '当前作答进度不会保存。', '退出', function () {
            stopTimer();
            App.paper = null;
            App.tab = 'setup';
            App.view = 'setup';
            render();
          });
          break;
        }
        if (view === 'wrong') {
          openWrong();
          break;
        }
        App.tab = view;
        App.view = view;
        App.reviewSource = null;
        render();
        break;

      case 'subject-menu':
        App.menuOpen = !App.menuOpen;
        renderChrome();
        if (App.menuOpen) focusMenuItem();
        break;

      case 'subject-close':
        App.menuOpen = false;
        renderChrome();
        focusSubjectTrigger();
        break;

      case 'subject':
        var sid = target.getAttribute('data-sid');
        if (!sid || sid === App.sid) {
          App.menuOpen = false;
          renderChrome();
          break;
        }
        if (App.view === 'quiz' && App.paper) {
          App.menuOpen = false;
          renderChrome();
          openModal('切换学科？', '当前试卷的作答进度不会保存，确定要切换学科吗？', '切换', function () {
            stopTimer();
            App.paper = null;
            switchSubject(sid);
          });
          break;
        }
        switchSubject(sid);
        break;

      case 'module':
        var moduleId = target.getAttribute('data-mod');
        var module = App.meta.modules.filter(function (m) { return m.id === moduleId; })[0];
        var allOn = module.chapters.every(function (c) { return App.selection[moduleId + '/' + c.id]; });
        module.chapters.forEach(function (c) {
          var key = moduleId + '/' + c.id;
          if (allOn) delete App.selection[key];
          else App.selection[key] = true;
        });
        persistConfig();
        render();
        break;

      case 'chapter':
        var key = target.getAttribute('data-key');
        if (App.selection[key]) delete App.selection[key];
        else App.selection[key] = true;
        persistConfig();
        render();
        break;

      case 'expand':
        var mid = target.getAttribute('data-mod');
        App.expanded[mid] = !App.expanded[mid];
        render();
        break;

      case 'select-all': onSelectAll('all'); break;
      case 'select-none': onSelectAll('none'); break;
      case 'select-invert': onSelectAll('invert'); break;

      case 'count':
        persistConfig({ count: parseInt(target.getAttribute('data-n'), 10) });
        render();
        break;

      case 'mode':
        persistConfig({ mode: target.getAttribute('data-mode') });
        render();
        break;

      case 'strategy':
        persistConfig({ strategy: target.getAttribute('data-strategy') });
        render();
        break;

      case 'toggle-fig':
        persistConfig({ includeFig: !App.config.includeFig });
        render();
        break;

      case 'toggle-onlynew':
        persistConfig({ onlyNew: !App.config.onlyNew });
        render();
        break;

      case 'toggle-store':
        var nextMode = Store.mode() === 'local' ? 'session' : 'local';
        var applied = Store.setMode(nextMode);
        if (applied === 'local') {
          toast('已改为本机长期保存，关闭浏览器也不会丢（清理缓存会丢）');
        } else if (applied === 'session') {
          toast('已改为仅本次标签页，关闭标签页后自动清空');
        } else {
          toast('浏览器禁用了存储，记录只在当前页面内存中');
        }
        render();
        break;

      case 'export-records':
        exportRecords();
        break;

      case 'import-records':
        importRecords();
        break;

      case 'start':
        startPaper();
        break;

      case 'pick':
        pickOption(parseInt(target.getAttribute('data-i'), 10), target.getAttribute('data-key'));
        break;

      case 'goto':
        gotoQuestion(parseInt(target.getAttribute('data-i'), 10));
        break;

      case 'prev':
        gotoQuestion(App.paper.index - 1);
        break;

      case 'next':
        nextQuestion();
        break;

      case 'mark':
        var idx = App.paper.index;
        if (App.paper.marked[idx]) delete App.paper.marked[idx];
        else App.paper.marked[idx] = true;
        render();
        break;

      case 'submit':
        submitPaper();
        break;

      case 'exit':
        openModal('退出本次答题？', '当前作答进度不会保存。', '退出', function () {
          stopTimer();
          App.paper = null;
          App.view = 'setup';
          render();
        });
        break;

      case 'modal-cancel':
        closeModal();
        break;

      case 'modal-confirm':
        var fn = App.modalConfirm;
        closeModal();
        if (fn) fn();
        break;

      case 'open-review':
        openReview();
        break;

      case 'restart':
        App.tab = 'setup';
        App.view = 'setup';
        App.reviewSource = null;
        App.result = null;
        App.review = null;
        render();
        break;

      case 'retry-wrong':
        var wrongCount = App.result ? App.result.grade.wrong : (App.review ? App.review.grade.wrong : 0);
        if (!wrongCount) { toast('本次没有错题'); break; }
        retryWrongFromPaper();
        break;

      case 'filter':
        App.review.filter = target.getAttribute('data-filter');
        render();
        break;

      case 'history-open':
        openHistoryReview(target.getAttribute('data-id'));
        break;

      case 'history-del':
        Store.removeHistory(target.getAttribute('data-id'));
        render();
        break;

      case 'history-clear':
        openModal('清空历史记录？', '只删除成绩记录，不会影响错题本。', '清空', function () {
          Store.clearHistory();
          render();
        });
        break;

      case 'wrong-quiz':
        startWrongPaper(parseInt(target.getAttribute('data-n'), 10));
        break;

      case 'wrong-more':
        App.wrongLimit = (App.wrongLimit || 50) + 50;
        render();
        break;

      case 'wrong-clear':
        openModal('清空错题本？', '连同每道题的历史正确率一起清除。', '清空', function () {
          Store.clearRecords(App.sid);
          render();
        });
        break;

      default:
        break;
    }
  }

  function pickOption(index, key) {
    var paper = App.paper;
    if (!paper) return;
    if (paper.mode === 'practice' && paper.revealed[paper.index]) return;
    paper.answers[paper.index] = key;
    if (paper.mode === 'practice') paper.revealed[paper.index] = true;
    if (paper.mode === 'practice') Store.recordAnswer(App.sid, paper.entries[paper.index].qid, key === paper.entries[paper.index].q.ans);
    render();
  }

  function gotoQuestion(index) {
    var paper = App.paper;
    if (!paper || index < 0 || index >= paper.entries.length) return;
    paper.index = index;
    render();
  }

  function nextQuestion() {
    var paper = App.paper;
    if (!paper) return;
    if (paper.index >= paper.entries.length - 1) {
      if (paper.mode === 'practice') submitPaper();
      else toast('已经是最后一题了');
      return;
    }
    paper.index += 1;
    render();
  }

  function retryWrongFromPaper() {
    var grade = App.result ? App.result.grade : App.review.grade;
    var entries = App.result ? App.result.entries : App.review.entries;
    var wrongQids = Object.create(null);
    grade.items.forEach(function (item) { if (!item.ok) wrongQids[item.qid] = true; });
    var items = entries.filter(function (entry) { return wrongQids[entry.qid]; }).map(function (entry) {
      return { qid: entry.qid, moduleId: entry.moduleId, chapterId: entry.chapterId };
    });
    if (!items.length) { toast('没有错题'); return; }
    withLoading('正在组卷…', function () {
      return ensureModules(App.sid, unique(items.map(function (i) { return i.moduleId; })));
    }).then(function () {
      var pool = Engine.fromRecords(App.sid, App.meta, items);
      App.paper = {
        entries: Engine.shuffle(pool),
        answers: pool.map(function () { return ''; }),
        marked: Object.create(null),
        revealed: Object.create(null),
        index: 0,
        mode: 'exam',
        startedAt: Date.now(),
        elapsed: 0,
        config: { count: pool.length, mode: 'exam', strategy: 'wrong', includeFig: true, onlyNew: false }
      };
      App.tab = 'setup';
      App.view = 'quiz';
      App.reviewSource = null;
      render();
      startTimer();
    }).catch(function (err) { toast(err.message || '加载失败'); });
  }

  // ------------------------------------------------------------- 键盘
  function handleKey(event) {
    if (App.menuOpen) {
      if (event.key === 'Escape') {
        App.menuOpen = false;
        renderChrome();
        focusSubjectTrigger();
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        moveMenuFocus(event.key === 'ArrowDown' ? 1 : -1);
        event.preventDefault();
        return;
      }
    }
    if (App.view !== 'quiz' || !App.paper) return;
    if (event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
    if (document.querySelector('#modal.is-on')) return;

    var paper = App.paper;
    var rec = paper.entries[paper.index].q;
    var optCount = (rec.opts || []).length;
    var key = event.key.toUpperCase();

    if (key.length === 1 && LETTERS.indexOf(key) >= 0 && LETTERS.indexOf(key) < optCount) {
      pickOption(LETTERS.indexOf(key), key);
      event.preventDefault();
      return;
    }
    if (event.key >= '1' && event.key <= '9') {
      var i = parseInt(event.key, 10) - 1;
      if (i < optCount) {
        pickOption(i, LETTERS.charAt(i));
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      gotoQuestion(paper.index - 1);
      event.preventDefault();
    }
    if (event.key === 'ArrowRight') {
      nextQuestion();
      event.preventDefault();
    }
  }

  // ------------------------------------------------------------- 启动
  function boot() {
    QBANK.wire();
    var entry = QBANK.subjects[0];
    if (!entry) {
      $('#app').innerHTML = '<section class="panel empty-panel"><h2>没有找到题库</h2>' +
        '<p class="muted">请确认 <code>data/subjects.js</code> 存在，并且已经运行过 <code>tools/build_bank.py</code>。</p></section>';
      return;
    }
    App.sid = entry.id;
    withLoading('正在读取题库…', function () {
      return ensureSubject(App.sid);
    }).then(function () {
      App.meta = QBANK.metas[App.sid];
      loadConfig();
      render();
      if (!Store.isAvailable()) toast('浏览器禁用了会话存储，刷新页面会丢失本次记录');
    }).catch(function (err) {
      $('#app').innerHTML = '<section class="panel empty-panel"><h2>题库加载失败</h2>' +
        '<p class="muted">' + esc(err.message) + '</p></section>';
    });
  }

  document.addEventListener('click', handleClick);
  document.addEventListener('keydown', handleKey);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
