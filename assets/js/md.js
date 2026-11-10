/*
 * 解析渲染器
 * 题库里的「解析」字段格式并不统一：既有 Markdown 片段（### 选项分析、**加粗**、- 列表），
 * 也混着原生 HTML（<strong>、<ul>、<li>、<div>），还常常整段没有换行。
 * 这里统一转成可读的 HTML，并且只放行白名单标签，避免执行题库里的任意脚本。
 */
(function (global) {
  'use strict';

  var ALLOWED = /^(strong|b|em|i|u|sub|sup|br|p|div|ul|ol|li|h3|h4|h5|span)$/i;

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // 先整体转义，再只还原白名单标签（属性一律丢弃）
  function restoreTags(text) {
    return text.replace(/&lt;(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^&]*)?)&gt;/g, function (m, slash, tag, attrs) {
      var name = tag.toLowerCase();
      if (!ALLOWED.test(name)) return '';
      if (slash) return '</' + name + '>';
      if (name === 'br') return '<br>';
      return '<' + name + '>';
    });
  }

  function inline(text) {
    var s = text;
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*\*/g, '');
    return s;
  }

  function paragraph(text) {
    var body = text.replace(/^\s+|\s+$/g, '');
    if (!body) return '';
    body = inline(body).replace(/\n/g, '<br>');
    return '<p>' + body + '</p>';
  }

  // 少数解析带 Markdown 表格（题库里行与行之间用 || 分隔，且整段没有换行）
  function hasTable(text) {
    return /\|[-:\s]{3,}/.test(text);
  }

  function splitTableSegments(text) {
    var parts = [];
    var buffer = '';

    function flush() {
      if (buffer.replace(/\s/g, '')) {
        parts.push({ type: 'text', value: buffer });
      }
      buffer = '';
    }

    function addText(value) {
      if (!value) return;
      buffer += (buffer ? ' ' : '') + value;
    }

    text.split('||').forEach(function (segment) {
      var t = segment.replace(/^\s+|\s+$/g, '');
      if (!t) return;

      var pipeAt = t.indexOf('|');
      if (pipeAt < 0) {
        addText(t);
        return;
      }

      // 表格行前面可能粘着一段普通文字，先把它切出来
      var prefix = t.slice(0, pipeAt).replace(/^\s+|\s+$/g, '');
      var body = t.slice(pipeAt).replace(/^\|+/, '').replace(/\|+$/, '');

      // |---|---| 这种纯分隔行直接丢弃
      if (body.replace(/[\s|:\-]/g, '') === '') return;

      // 表格尾部常常直接粘着「### 结论」之类的小标题，切出来当正文
      var headingTail = '';
      var headMatch = body.match(/#{2,5}\s/);
      if (headMatch) {
        if (headMatch.index === 0) {
          addText(t);
          return;
        }
        headingTail = body.slice(headMatch.index);
        body = body.slice(0, headMatch.index);
      }

      var tailSplit = body.split(/\s*-{3,}\s*/);
      var cellsPart = tailSplit[0];
      var tail = tailSplit.slice(1).join(' ');
      var cells = cellsPart.split('|').map(function (c) {
        return c.replace(/^\s+|\s+$/g, '');
      }).filter(function (c) {
        return c !== '';
      });
      var prefixIsDivider = prefix === '' || /^[-:\s]+$/.test(prefix);
      // 「|| **A** | 左小腿部 | ...」里被 || 吃掉的第一个单元格
      var prefixIsCell = !prefixIsDivider && prefix.length <= 24 && !/[。：；！？]/.test(prefix);
      var onlyDividers = cells.length > 0 && cells.every(function (c) {
        return /^[-:\s]+$/.test(c);
      });

      if (!prefixIsDivider && !prefixIsCell) addText(prefix);
      if (cells.length && !onlyDividers) {
        if (prefixIsCell) cells.unshift(prefix);
        flush();
        parts.push({
          type: 'html',
          value: '<div class="md-tr">' + cells.map(function (c) {
            return '<span class="md-td">' + inline(c) + '</span>';
          }).join('') + '</div>'
        });
      }
      if (tail) addText(tail);
      if (headingTail) addText(headingTail);
    });

    flush();
    return parts;
  }

  var MARKERS = /\u0001([BHNR]|N\d{1,2})\u0001/;

  function renderText(text) {
    var work = text;
    // 列表项：题库用「- **」开头，且常常紧跟在句号、冒号后面
    work = work.replace(/(^|[\s。：；，,、）)】」])\s*[-•]\s*(?=\*\*|<strong>|[A-E][.．、]|[\u4e00-\u9fa5])/g, '$1\u0001B\u0001');
    // 编号项：「1. **」
    work = work.replace(/(^|[\s。：；，,）)])(\d{1,2})[.．]\s*(?=\*\*|<strong>)/g, '$1\u0001N$2\u0001');
    // 小标题
    work = work.replace(/#{2,5}\s*/g, '\u0001H\u0001');
    // 分隔线
    work = work.replace(/---+/g, '\u0001R\u0001');

    var parts = work.split(MARKERS);
    if (parts.length === 1) {
      return paragraph(parts[0]);
    }

    var out = [];
    var listType = null;
    var listItems = [];

    function flushList() {
      if (listType) {
        out.push('<' + listType + '>' + listItems.join('') + '</' + listType + '>');
      }
      listType = null;
      listItems = [];
    }

    function addItem(kind, html) {
      if (listType && listType !== kind) flushList();
      listType = kind;
      listItems.push('<li>' + html + '</li>');
    }

    for (var i = 0; i < parts.length; i += 2) {
      var chunk = parts[i] || '';
      var marker = i > 0 ? parts[i - 1] : '';

      if (marker === 'B') {
        addItem('ul', inline(chunk).replace(/<p>/g, ''));
        continue;
      }
      if (marker && marker.charAt(0) === 'N') {
        addItem('ol', inline(chunk).replace(/<p>/g, ''));
        continue;
      }
      if (marker === 'H') {
        flushList();
        out.push('<h4>' + inline(chunk) + '</h4>');
        continue;
      }
      if (marker === 'R') {
        flushList();
        out.push('<hr>');
        if (chunk.replace(/\s/g, '')) out.push(paragraph(chunk));
        continue;
      }

      if (!chunk.replace(/\s/g, '')) continue;
      flushList();
      out.push(paragraph(chunk));
    }
    flushList();
    return out.join('');
  }

  function render(raw) {
    if (raw == null || raw === '') return '';
    var text = restoreTags(escapeHtml(raw));
    if (!text.replace(/\s/g, '')) return '';

    if (hasTable(text)) {
      return splitTableSegments(text).map(function (part) {
        return part.type === 'html' ? part.value : renderText(part.value);
      }).join('');
    }
    return renderText(text);
  }

  global.MD = { render: render, escape: escapeHtml };
})(typeof window !== 'undefined' ? window : globalThis);
