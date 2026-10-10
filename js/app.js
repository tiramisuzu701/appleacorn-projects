/*
 * Writing site — a tiny single-page reader.
 * Everything you write lives in /content. You shouldn't need to edit this file.
 *
 * URLs look like:
 *   #/                     home page
 *   #/work/<slug>          a work's overview + table of contents
 *   #/read/<slug>/<n>      chapter n of a work (starting at 1)
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'writing-site-settings';
  var PROGRESS_KEY = 'writing-site-progress';
  var DEFAULTS = { theme: 'system', size: 100, font: 'serif', leading: 1.75, width: 38 };
  var WORDS_PER_MINUTE = 250;

  var $ = function (sel) { return document.querySelector(sel); };
  var root = document.documentElement;
  var data = null;              // contents of works.json
  var textCache = {};           // url -> markdown text

  /* ---------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }
  function fetchText(url) {
    if (textCache[url]) return Promise.resolve(textCache[url]);
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
      return r.text();
    }).then(function (t) { textCache[url] = t; return t; });
  }
  function wordCount(md) {
    var m = md.replace(/[#>*_`~\-]+/g, ' ').match(/[\w’'-]+/g);
    return m ? m.length : 0;
  }
  function readTime(words) {
    var mins = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    return mins + ' min read';
  }
  function fmt(n) { return n.toLocaleString(); }
  function renderMarkdown(md) {
    // A line with only *** , * * * , or ### between paragraphs becomes a scene break (marked turns *** into <hr>).
    return window.marked.parse(md, { gfm: true, breaks: false });
  }
  function chapterUrl(work, ch) { return 'content/works/' + work.slug + '/' + ch.file; }
  function visibleWorks() { return data.works.filter(function (w) { return !w.hidden; }); }
  function findWork(slug) {
    for (var i = 0; i < data.works.length; i++) if (data.works[i].slug === slug) return data.works[i];
    return null;
  }

  /* ---------------------------------------------------------------
     Reading progress (remembered per browser)
     --------------------------------------------------------------- */
  var progress = load(PROGRESS_KEY, { last: null, read: {} });
  function markRead(slug, n) {
    progress.last = { slug: slug, n: n, at: Date.now() };
    progress.read[slug] = progress.read[slug] || [];
    if (progress.read[slug].indexOf(n) === -1) progress.read[slug].push(n);
    save(PROGRESS_KEY, progress);
  }
  function hasRead(slug, n) { return (progress.read[slug] || []).indexOf(n) !== -1; }

  /* ---------------------------------------------------------------
     Settings panel
     --------------------------------------------------------------- */
  var settings = Object.assign({}, DEFAULTS, load(SETTINGS_KEY, {}));
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applySettings() {
    var theme = settings.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme;
    root.dataset.theme = theme;
    root.dataset.font = settings.font;
    root.style.setProperty('--scale', settings.size / 100);
    root.style.setProperty('--leading', settings.leading);
    root.style.setProperty('--measure', settings.width + 'em');

    document.querySelectorAll('.seg').forEach(function (seg) {
      var key = seg.dataset.setting;
      seg.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(String(settings[key]) === b.dataset.value));
      });
    });
    $('#size').value = settings.size;
    $('#size-out').textContent = settings.size + '%';
  }
  function setSetting(key, value) {
    settings[key] = value;
    save(SETTINGS_KEY, settings);
    applySettings();
  }

  function initSettings() {
    document.querySelectorAll('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        var key = seg.dataset.setting;
        var v = b.dataset.value;
        setSetting(key, (key === 'leading' || key === 'width') ? Number(v) : v);
      });
    });
    $('#size').addEventListener('input', function (e) { setSetting('size', Number(e.target.value)); });
    $('#size-down').addEventListener('click', function () { setSetting('size', Math.max(80, settings.size - 5)); });
    $('#size-up').addEventListener('click', function () { setSetting('size', Math.min(160, settings.size + 5)); });
    $('#reset-settings').addEventListener('click', function () {
      settings = Object.assign({}, DEFAULTS);
      save(SETTINGS_KEY, settings);
      applySettings();
    });
    darkQuery.addEventListener('change', function () { if (settings.theme === 'system') applySettings(); });

    var panel = $('#settings');
    var opener = $('#open-settings');
    function open(state) {
      panel.hidden = !state;
      opener.setAttribute('aria-expanded', String(state));
    }
    opener.addEventListener('click', function (e) { e.stopPropagation(); open(panel.hidden); });
    $('#close-settings').addEventListener('click', function () { open(false); opener.focus(); });
    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) { open(false); opener.focus(); }
    });
    applySettings();
  }

  /* ---------------------------------------------------------------
     Sidebar
     --------------------------------------------------------------- */
  var openWorks = {}; // which works are expanded in the sidebar

  function renderSidebar(route) {
    var html = '<a class="nav-link' + (route.view === 'home' ? ' active' : '') + '" href="#/">Home</a>';
    var works = visibleWorks();
    if (works.length) html += '<div class="nav-label">Works</div>';

    // A hidden work you're currently reading still shows, so readers aren't lost.
    var current = route.work && route.work.hidden ? [route.work] : [];

    works.concat(current).forEach(function (w) {
      var isCurrent = route.work === w;
      if (isCurrent) openWorks[w.slug] = true;
      var opened = !!openWorks[w.slug];
      html += '<div class="work' + (isCurrent ? ' current' : '') + '" data-open="' + opened + '" data-slug="' + esc(w.slug) + '">' +
        '<button class="work-toggle" aria-expanded="' + opened + '">' +
          '<span class="work-title">' + esc(w.title) + '</span>' +
          '<svg class="chev" viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button><ul class="chapters">' +
        '<li class="overview"><a href="#/work/' + esc(w.slug) + '"' +
          (isCurrent && route.view === 'work' ? ' class="active"' : '') + '>About this work</a></li>';
      (w.chapters || []).forEach(function (ch, i) {
        var n = i + 1;
        var active = isCurrent && route.view === 'read' && route.n === n;
        html += '<li><a href="#/read/' + esc(w.slug) + '/' + n + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' +
          (w.numbered === false ? '' : '<span class="num">' + n + '</span>') +
          '<span>' + esc(ch.title) + '</span></a></li>';
      });
      html += '</ul></div>';
    });

    $('#nav').innerHTML = html;
    var active = $('#nav .chapters a.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function initSidebar() {
    $('#nav').addEventListener('click', function (e) {
      var t = e.target.closest('.work-toggle');
      if (t) {
        var w = t.parentElement;
        var opened = w.dataset.open !== 'true';
        w.dataset.open = String(opened);
        t.setAttribute('aria-expanded', String(opened));
        openWorks[w.dataset.slug] = opened;
        return;
      }
      if (e.target.closest('a')) document.body.classList.remove('nav-open');
    });
    $('#open-sidebar').addEventListener('click', function () { document.body.classList.add('nav-open'); });
    $('#close-sidebar').addEventListener('click', function () { document.body.classList.remove('nav-open'); });
    $('#scrim').addEventListener('click', function () { document.body.classList.remove('nav-open'); });
    $('#brand').addEventListener('click', function () { document.body.classList.remove('nav-open'); });
  }

  /* ---------------------------------------------------------------
     Views
     --------------------------------------------------------------- */
  function tagsHtml(w) {
    var tags = [];
    if (w.status) tags.push('<span class="tag status">' + esc(w.status) + '</span>');
    (w.tags || []).forEach(function (t) { tags.push('<span class="tag">' + esc(t) + '</span>'); });
    var n = (w.chapters || []).length;
    if (n) tags.push('<span class="tag">' + n + (n === 1 ? ' part' : (w.unit ? ' ' + esc(w.unit) : ' chapters')) + '</span>');
    return tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '';
  }

  function viewHome() {
    var site = data.site || {};
    document.title = site.title || 'Appleacorn Projects';
    setCrumb('');
    var intro = site.homePage ? fetchText(site.homePage).catch(function () { return ''; }) : Promise.resolve('');
    return intro.then(function (md) {
      var html = '<div class="page">' +
        '<div class="hero"><h1>' + esc(site.title || 'Appleacorn Projects') + '</h1>' +
        (site.tagline ? '<p>' + esc(site.tagline) + '</p>' : '') + '</div>';
      if (md) html += '<div class="prose home-intro">' + renderMarkdown(md) + '</div>';

      var last = progress.last && findWork(progress.last.slug);
      if (last && last.chapters && last.chapters[progress.last.n - 1]) {
        var ch = last.chapters[progress.last.n - 1];
        html += '<a class="continue" href="#/read/' + esc(last.slug) + '/' + progress.last.n + '">' +
          '<div><div class="k">Continue reading</div><div class="v">' + esc(last.title) + ' — ' + esc(ch.title) + '</div></div>' +
          '<span class="arrow">→</span></a>';
      }

      var works = visibleWorks();
      if (works.length) {
        html += '<h2 class="section-title">Works</h2><div class="cards">';
        works.forEach(function (w) {
          html += '<a class="card" href="#/work/' + esc(w.slug) + '">' +
            '<h3>' + esc(w.title) + '</h3>' + tagsHtml(w) +
            (w.blurb ? '<p>' + esc(w.blurb) + '</p>' : '') + '</a>';
        });
        html += '</div>';
      }
      return html + '</div>';
    });
  }

  function viewWork(work) {
    document.title = work.title + ' · ' + ((data.site && data.site.title) || 'Appleacorn Projects');
    setCrumb('<a href="#/work/' + esc(work.slug) + '">' + esc(work.title) + '</a>');
    var chapters = work.chapters || [];
    // Load every chapter to show word counts (they're cached for reading later).
    return Promise.all(chapters.map(function (ch) {
      return fetchText(chapterUrl(work, ch)).then(wordCount).catch(function () { return 0; });
    })).then(function (counts) {
      var total = counts.reduce(function (a, b) { return a + b; }, 0);
      var html = '<div class="page work-page">' +
        '<div class="hero"><h1>' + esc(work.title) + '</h1>' +
        (work.subtitle ? '<p>' + esc(work.subtitle) + '</p>' : '') + '</div>' + tagsHtml(work);
      if (work.summary || work.blurb) {
        html += '<div class="work-summary prose">' + renderMarkdown(work.summary || work.blurb) + '</div>';
      }
      if (chapters.length) {
        var resume = 1;
        for (var i = 0; i < chapters.length; i++) { if (!hasRead(work.slug, i + 1)) { resume = i + 1; break; } }
        var started = (progress.read[work.slug] || []).length > 0;
        html += '<a class="start-btn" href="#/read/' + esc(work.slug) + '/' + resume + '">' +
          (started ? 'Continue from ' + (work.numbered === false ? '“' + esc(chapters[resume - 1].title) + '”' : (work.unitSingular || 'chapter') + ' ' + resume) : 'Start reading') + ' →</a>';
        html += '<h2 class="section-title">Contents · ' + fmt(total) + ' words</h2><ol class="toc">';
        chapters.forEach(function (ch, i) {
          html += '<li><a href="#/read/' + esc(work.slug) + '/' + (i + 1) + '"' + (hasRead(work.slug, i + 1) ? ' class="read"' : '') + '>' +
            (work.numbered === false ? '' : '<span class="num">' + (i + 1) + '</span>') +
            '<span class="t">' + esc(ch.title) + '</span>' +
            '<span class="wc">' + fmt(counts[i]) + ' words</span></a></li>';
        });
        html += '</ol>';
      } else {
        html += '<p style="color:var(--muted)">Nothing posted here yet.</p>';
      }
      return html + '</div>';
    });
  }

  function viewChapter(work, n) {
    var chapters = work.chapters || [];
    var ch = chapters[n - 1];
    if (!ch) return Promise.resolve(notFound());
    document.title = ch.title + ' · ' + work.title;
    setCrumb('<a href="#/work/' + esc(work.slug) + '">' + esc(work.title) + '</a> &nbsp;/&nbsp; ' + esc(ch.title));

    return fetchText(chapterUrl(work, ch)).then(function (md) {
      // If the file starts with its own "# Title" heading, don't show the title twice.
      md = md.replace(/^﻿?\s*#\s+.+\n+/, '');
      var words = wordCount(md);
      var label = work.numbered === false ? '' : ((work.unitSingular || 'Chapter') + ' ' + n);
      var html = '<header class="chapter-head">' +
        '<div class="eyebrow"><a href="#/work/' + esc(work.slug) + '">' + esc(work.title) + '</a>' +
        (label ? ' · ' + esc(label.charAt(0).toUpperCase() + label.slice(1)) : '') + '</div>' +
        '<h1>' + esc(ch.title) + '</h1>' +
        '<div class="meta">' + fmt(words) + ' words · ' + readTime(words) + '</div>' +
        '<span class="ornament">· · ·</span></header>' +
        '<div class="prose chapter-body">' + renderMarkdown(md) + '</div>';

      var prev = chapters[n - 2], next = chapters[n];
      html += '<nav class="pager" aria-label="Chapter navigation">';
      if (prev) html += '<a class="prev" href="#/read/' + esc(work.slug) + '/' + (n - 1) + '" rel="prev"><span class="dir">← Previous</span><span class="t">' + esc(prev.title) + '</span></a>';
      if (next) html += '<a class="next" href="#/read/' + esc(work.slug) + '/' + (n + 1) + '" rel="next"><span class="dir">Next →</span><span class="t">' + esc(next.title) + '</span></a>';
      if (!next) html += '<div class="pager-end">' + (work.status && /complete|finished/i.test(work.status) ? 'The end.' : 'You’re all caught up.') +
        ' <a href="#/work/' + esc(work.slug) + '">Back to contents</a></div>';
      html += '</nav>';

      markRead(work.slug, n);
      // Warm the cache so "Next" opens instantly.
      if (next) fetchText(chapterUrl(work, next)).catch(function () {});
      return html;
    });
  }

  function notFound() {
    setCrumb('');
    return '<div class="notice"><h2>Page not found</h2><p>That page doesn’t exist (or was moved). <a href="#/">Go home</a>.</p></div>';
  }

  function errorView(err) {
    var local = location.protocol === 'file:';
    return '<div class="notice"><h2>' + (local ? 'Open this site through a web server' : 'Something didn’t load') + '</h2>' +
      (local
        ? '<p>Browsers block websites opened straight from a folder from reading their own files, so your chapters can’t load this way.</p>' +
          '<p>Either upload it to GitHub Pages (see the README), or preview it on your computer: open a terminal in this folder and run <code>python3 -m http.server</code>, then visit <a href="http://localhost:8000">localhost:8000</a>.</p>'
        : '<p>' + esc(err && err.message) + '</p><p>Check that the file name in <code>content/works.json</code> matches the file in the folder exactly (including capital letters).</p>') +
      '</div>';
  }

  function setCrumb(html) { $('#crumb').innerHTML = html; }

  /* ---------------------------------------------------------------
     Router
     --------------------------------------------------------------- */
  function parseRoute() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return { view: 'home' };
    var work = findWork(parts[1]);
    if (parts[0] === 'work' && work) return { view: 'work', work: work };
    if (parts[0] === 'read' && work) return { view: 'read', work: work, n: parseInt(parts[2], 10) || 1 };
    return { view: 'missing' };
  }

  var renderToken = 0;
  function route() {
    var r = parseRoute();
    var token = ++renderToken;
    renderSidebar(r);
    var p = r.view === 'home' ? viewHome()
      : r.view === 'work' ? viewWork(r.work)
      : r.view === 'read' ? viewChapter(r.work, r.n)
      : Promise.resolve(notFound());
    p.catch(errorView).then(function (html) {
      if (token !== renderToken) return; // a newer navigation won
      $('#content').innerHTML = html;
      window.scrollTo(0, 0);
      $('#main').focus({ preventScroll: true });
      onScroll();
    });
  }

  /* ---------------------------------------------------------------
     Scroll: progress bar + top bar shadow
     --------------------------------------------------------------- */
  function onScroll() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var reading = parseRoute().view === 'read';
    $('#progress').style.width = reading && h > 0 ? Math.min(100, (window.scrollY / h) * 100) + '%' : '0';
    document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 40);
  }

  /* Keyboard: ← / → to move between chapters */
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (/input|textarea|select/i.test(document.activeElement.tagName)) return;
    if (!$('#settings').hidden) return;
    var link = e.key === 'ArrowLeft' ? $('.pager .prev') : e.key === 'ArrowRight' ? $('.pager .next') : null;
    if (link) { e.preventDefault(); location.hash = link.getAttribute('href'); }
  }

  /* ---------------------------------------------------------------
     Start
     --------------------------------------------------------------- */
  initSettings();
  initSidebar();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKey);

  fetchText('content/works.json').then(function (txt) {
    data = JSON.parse(txt);
    data.works = data.works || [];
    var site = data.site || {};
    $('#brand').textContent = site.title || 'Appleacorn Projects';
    if (site.footer) $('#sidebar-foot').textContent = site.footer;
    window.addEventListener('hashchange', route);
    route();
  }).catch(function (err) {
    if (err instanceof SyntaxError) {
      err = new Error('content/works.json has a formatting mistake: ' + err.message + '. A missing comma or an extra one at the end of a list is the usual culprit.');
    }
    $('#content').innerHTML = errorView(err);
  });
})();
