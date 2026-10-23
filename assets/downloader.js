// نينال سوفت: APK download for an app page and its install/ page.
//
// #dl, the main button, is a PLAIN direct link to the file (with a download
// name) and nothing here intercepts it: the browser's download manager takes
// it, and the person can close the page. This script only fills it (and the
// size, #dlmb) from version.json so it always points at the latest version;
// without JavaScript the href written in the HTML is used as is.
//
// #dlsafe (and any [data-safe]) is the SECONDARY "safe download", for when
// mobile Chrome's downloader saved the APK with a block of zeros in the
// middle → "package appears to be invalid". It warns first that the page has
// to stay open, then: version.json → ONE sequential fetch with a progress bar
// and a cancel button → on a cut, resume with Range from the last byte
// received (up to 5 retries, growing wait) → check size + SHA-256
// (crypto.subtle) → wrong: download once more from zero → right: save the
// Blob as "<data-file><version>.apk" (default "فواتير-وديون-"). A failure
// offers "try again"; it never switches to the direct link on its own.
//
// Attributes on #dl: data-version (version.json URL, default "version.json"),
// data-file (Arabic file-name prefix).
(function () {
  'use strict';
  var btn = document.getElementById('dl');
  var box = document.getElementById('dlbox');
  if (!btn) return;

  var VERSION_URL = btn.getAttribute('data-version') || 'version.json';
  var FILE_PREFIX = btn.getAttribute('data-file') || 'فواتير-وديون-';
  var MAX_RETRIES = 5;
  var supported = !!(window.fetch && window.crypto && window.crypto.subtle &&
    window.ReadableStream && window.Blob && window.URL && window.AbortController &&
    'download' in document.createElement('a'));
  var running = null; // AbortController of the current safe download

  function mb(n) { return (n / 1e6).toFixed(1); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, id, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', onClick);
    return b;
  }
  function sleep(ms, signal) {
    return new Promise(function (res, rej) {
      var t = setTimeout(res, ms);
      if (signal) signal.addEventListener('abort', function () { clearTimeout(t); rej(abortErr()); });
    });
  }
  function abortErr() { var e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  // ---- the direct button: latest href + download name + size ----
  function fillDirect(info) {
    if (!info) return;
    if (info.apk) btn.href = info.apk;
    if (info.version) btn.setAttribute('download', FILE_PREFIX + info.version + '.apk');
    var size = document.getElementById('dlmb');
    if (size && info.size > 0) size.textContent = mb(info.size);
  }
  fetch(VERSION_URL, { cache: 'no-store' }).then(function (r) {
    return r.ok ? r.json() : null;
  }).then(fillDirect).catch(function () {});

  if (!box) return;

  // ---- safe download UI (all inside #dlbox) ----
  function show(nodes, state) {
    box.hidden = false;
    box.textContent = '';
    nodes.forEach(function (n) { box.appendChild(n); });
    box.setAttribute('data-state', state);
  }
  function hide() { box.hidden = true; box.textContent = ''; box.removeAttribute('data-state'); }
  var bar, label;
  function resetProgress() { bar = null; label = null; }
  function showProgress(got, total) {
    if (!bar) {
      var track = el('div', 'dl-track');
      bar = el('div', 'dl-fill');
      track.appendChild(bar);
      label = el('p', 'dl-label');
      show([label, track, el('p', 'dl-warn', 'خلّي الصفحة مفتوحة لحتى يخلص.'),
        button('dl-cancel', 'dlcancel', 'إلغاء', function () { if (running) running.abort(); })], 'downloading');
    }
    var pct = total ? Math.min(100, Math.floor(got * 100 / total)) : 0;
    bar.style.width = pct + '%';
    label.textContent = 'عم ننزّل… ' + mb(got) + ' / ' + mb(total) + ' م.ب · ' + pct + '%';
  }
  function showConfirm() {
    if (running) return;
    resetProgress();
    if (!supported) {
      show([el('p', 'dl-label', 'متصفحك ما بيدعم الطريقة الآمنة. جرّب من Chrome، أو ابعتلنا على واتساب.'),
        button('dl-cancel', 'dlback', 'تمام', hide)], 'unsupported');
      return;
    }
    show([el('p', 'dl-label', 'هالطريقة بتتأكد إنه الملف سليم، بس لازم تضل الصفحة مفتوحة لحتى يخلص.'),
      button('dl-start', 'dlstart', 'ابدأ التنزيل الآمن', start),
      button('dl-cancel', 'dlback', 'إلغاء', hide)], 'confirm');
  }
  function showDone() {
    resetProgress();
    show([el('p', 'dl-ok', '✓ تم التنزيل والتأكد إنه سليم. افتح الملف من الإشعار أو من التنزيلات وثبّته')], 'done');
  }
  function showCancelled() {
    resetProgress();
    show([el('p', 'dl-label', 'انلغى التنزيل.'),
      button('dl-cancel', 'dlretry', 'جرّب مرة تانية', start)], 'cancelled');
  }
  function showFailed(why) {
    resetProgress();
    show([el('p', 'dl-label', why + ' تأكد من النت وجرّب مرة تانية.'),
      button('dl-start', 'dlretry', 'جرّب مرة تانية', start)], 'failed');
  }

  // ---- download: one sequential request, Range resume ----
  function fetchAll(url, total, signal) {
    var chunks = [];
    var got = 0;
    var attempt = 0;
    function once() {
      var headers = got > 0 ? { Range: 'bytes=' + got + '-' } : {};
      return fetch(url, { headers: headers, cache: 'no-store', signal: signal }).then(function (res) {
        if (res.status === 206 && got > 0) {
          // resume: append
        } else if (res.status === 200) {
          chunks = []; got = 0; // full body (server ignored Range)
        } else if (res.status === 416 && got > 0) {
          return; // nothing left
        } else {
          throw new Error('HTTP ' + res.status);
        }
        var reader = res.body.getReader();
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            chunks.push(r.value);
            got += r.value.byteLength;
            showProgress(got, total);
            return pump();
          });
        }
        return pump();
      });
    }
    function loop() {
      return once().then(function () {
        if (got >= total) return;
        throw new Error('short ' + got);
      }).catch(function (e) {
        if (e && e.name === 'AbortError') throw e;
        if (got > total) { chunks = []; got = 0; }
        if (attempt >= MAX_RETRIES) throw e;
        attempt++;
        return sleep(1000 * Math.pow(2, attempt - 1), signal).then(loop);
      });
    }
    showProgress(0, total);
    return loop().then(function () {
      return new Blob(chunks, { type: 'application/vnd.android.package-archive' });
    });
  }

  function verify(blob, info) {
    if (blob.size !== info.size) return Promise.resolve(false);
    return blob.arrayBuffer().then(function (buf) {
      return crypto.subtle.digest('SHA-256', buf);
    }).then(function (d) { return hex(d) === String(info.file_sha256).toLowerCase(); });
  }

  function save(blob, version) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = FILE_PREFIX + version + '.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  function start() {
    if (running || !supported) return;
    var ctl = running = new AbortController();
    resetProgress();
    show([el('p', 'dl-label', 'عم نجهّز التنزيل…')], 'preparing');
    fetch(VERSION_URL, { cache: 'no-store', signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('version.json ' + r.status);
      return r.json();
    }).then(function (info) {
      if (!info || !info.apk || !info.file_sha256 || !(info.size > 0)) {
        showFailed('ما قدرنا نجيب معلومات النسخة.');
        return;
      }
      fillDirect(info);
      var round = 0;
      function attempt() {
        return fetchAll(info.apk, info.size, ctl.signal).then(function (blob) {
          return verify(blob, info).then(function (ok) {
            if (ok) { save(blob, info.version); showDone(); return; }
            if (round++ < 1) { resetProgress(); return attempt(); } // once more from zero
            showFailed('الملف ما نزل سليم.');
          });
        });
      }
      return attempt();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') showCancelled();
      else showFailed('ما قدرنا نكمّل التنزيل.');
    }).then(function () { running = null; });
  }

  var triggers = document.querySelectorAll('#dlsafe, [data-safe]');
  Array.prototype.forEach.call(triggers, function (t) {
    t.addEventListener('click', function (e) {
      e.preventDefault();
      showConfirm();
      if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });

  // Tests: the state machine without a click.
  window.__ninalDownloader = { start: start, confirm: showConfirm, supported: supported };
})();
