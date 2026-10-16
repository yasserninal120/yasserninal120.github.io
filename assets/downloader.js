// فواتير وديون: smart APK download for the app page (#dl button).
// Mobile Chrome's own downloader can save the APK with a block of zeros in
// the middle (parallel parts + a flaky line) → "package appears to be
// invalid". Here: version.json → ONE sequential fetch with a progress bar
// and a cancel button → on a cut, resume with Range from the last byte
// received (up to 5 retries, growing wait) → check size + SHA-256
// (crypto.subtle) → wrong: download once more from zero → right: save the
// Blob as "فواتير-وديون-<version>.apk". No fetch / crypto.subtle / streams,
// or everything failed: a plain direct link. Without JavaScript the button
// is a plain link to the file.
(function () {
  'use strict';
  var btn = document.getElementById('dl');
  var box = document.getElementById('dlbox');
  if (!btn || !box) return;

  var VERSION_URL = btn.getAttribute('data-version') || 'version.json';
  var MAX_RETRIES = 5;
  var supported = !!(window.fetch && window.crypto && window.crypto.subtle &&
    window.ReadableStream && window.Blob && window.URL && window.AbortController &&
    'download' in document.createElement('a'));
  var running = null; // AbortController of the current download

  function mb(n) { return (n / 1e6).toFixed(1); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
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

  // ---- UI states (all inside #dlbox) ----
  function show(nodes) {
    box.hidden = false;
    box.textContent = '';
    nodes.forEach(function (n) { box.appendChild(n); });
  }
  var bar, label;
  function showProgress(got, total) {
    if (!bar) {
      var track = el('div', 'dl-track');
      bar = el('div', 'dl-fill');
      track.appendChild(bar);
      label = el('p', 'dl-label');
      var cancel = el('button', 'dl-cancel', 'إلغاء');
      cancel.type = 'button';
      cancel.id = 'dlcancel';
      cancel.addEventListener('click', function () { if (running) running.abort(); });
      show([label, track, cancel]);
    }
    var pct = total ? Math.min(100, Math.floor(got * 100 / total)) : 0;
    bar.style.width = pct + '%';
    label.textContent = 'عم ننزّل… ' + mb(got) + ' / ' + mb(total) + ' MB · ' + pct + '%';
    box.setAttribute('data-state', 'downloading');
  }
  function resetProgress() { bar = null; label = null; }
  function showDone() {
    resetProgress();
    show([el('p', 'dl-ok', '✓ تم التنزيل. افتح الملف من الإشعار أو من التنزيلات وثبّته')]);
    box.setAttribute('data-state', 'done');
  }
  function showCancelled() {
    resetProgress();
    show([el('p', 'dl-label', 'انلغى التنزيل.')]);
    box.setAttribute('data-state', 'cancelled');
  }
  function showFallback(url, why) {
    resetProgress();
    var p = el('p', 'dl-label', why ? why + ' ' : '');
    var a = el('a', 'dl-direct', 'تنزيل مباشر للملف');
    a.href = url;
    a.id = 'dldirect';
    p.appendChild(a);
    show([p, el('p', 'dl-warn', 'إذا طلعلك «الحزمة غير صالحة»، احذف الملف ونزّل من جديد.')]);
    box.setAttribute('data-state', 'fallback');
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
    a.download = 'فواتير-وديون-' + version + '.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  function start() {
    if (running) return;
    var ctl = running = new AbortController();
    var direct = btn.href;
    resetProgress();
    show([el('p', 'dl-label', 'عم نجهّز التنزيل…')]);
    fetch(VERSION_URL, { cache: 'no-store', signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('version.json ' + r.status);
      return r.json();
    }).then(function (info) {
      if (!info || !info.apk || !info.file_sha256 || !(info.size > 0)) {
        showFallback(info && info.apk || direct);
        return;
      }
      direct = info.apk;
      var round = 0;
      function attempt() {
        return fetchAll(info.apk, info.size, ctl.signal).then(function (blob) {
          return verify(blob, info).then(function (ok) {
            if (ok) { save(blob, info.version); showDone(); return; }
            if (round++ < 1) { resetProgress(); return attempt(); } // once more from zero
            showFallback(info.apk, 'التنزيل ما كمل صح.');
          });
        });
      }
      return attempt();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') showCancelled();
      else showFallback(direct, 'ما قدرنا نكمّل التنزيل.');
    }).then(function () { running = null; });
  }

  btn.addEventListener('click', function (e) {
    if (!supported) { showFallback(btn.href); return; } // the plain link does it
    e.preventDefault();
    start();
  });

  // Tests: the state machine without a click.
  window.__debtbookDownloader = { start: start, supported: supported };
})();
