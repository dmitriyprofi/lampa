(function () {
  'use strict';

  var VERSION = '1.1.0';
  var FALLBACK_HOST = 'https://beta.l-vid.online/';
  var installed = false;
  var originalPlay = null;
  var originalPlaylist = null;

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[Lampa Trailer ALPAC Fix]');
      console.log.apply(console, args);
    } catch (e) {}
  }

  function detectAlpacHost() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src || '';
        if (!src) continue;
        if (/\/on(?:\.js|\/|\?|$)/i.test(src) && /l-vid\.online|alpac|alcopac/i.test(src)) {
          var m = src.match(/^(https?:\/\/[^\/]+)\//i);
          if (m && m[1]) return m[1] + '/';
        }
      }
    } catch (e) {}
    return FALLBACK_HOST;
  }

  function youtubeId(item) {
    if (!item) return '';
    if (item.id) return String(item.id);

    var url = String(item.url || '');
    var m = url.match(/[?&]v=([^&#]+)/i);
    if (m && m[1]) return m[1];

    m = url.match(/youtu\.be\/([^?&#/]+)/i);
    if (m && m[1]) return m[1];

    m = url.match(/youtube\.com\/embed\/([^?&#/]+)/i);
    return m && m[1] ? m[1] : '';
  }

  function isStockTrailer(item) {
    if (!item || item.__alpac_trailer_resolved) return false;
    if (item.youtube !== true) return false;
    if (!youtubeId(item)) return false;

    // Stock Lampa trailer selector builds these fields in
    // src/components/full/start/trailers.js.
    return item.template === 'selectbox_icon' ||
      (typeof item.code !== 'undefined' && typeof item.time !== 'undefined' && !!item.thumbnail);
  }

  function getToken() {
    var names = ['alpac_token', 'lampac_token', 'lampac_auth_token'];
    var token = '';

    try {
      if (window.Lampa && Lampa.Storage) {
        for (var i = 0; i < names.length && !token; i++) {
          token = Lampa.Storage.get(names[i], '') || '';
        }
      }
    } catch (e) {}

    if (!token) {
      try {
        token = localStorage.getItem('lampac_auth_token') || '';
      } catch (e) {}
    }

    if (!token) {
      try {
        for (var j = 0; j < names.length && !token; j++) {
          var re = new RegExp('(?:^|;\\s*)' + names[j] + '=([^;]*)');
          var match = document.cookie.match(re);
          if (match && match[1]) token = decodeURIComponent(match[1]);
        }
      } catch (e) {}
    }

    return token;
  }

  function addParam(url, name, value) {
    if (!value || new RegExp('(?:[?&])' + name + '=').test(url)) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') +
      encodeURIComponent(name) + '=' + encodeURIComponent(value);
  }

  function authenticatedUrl(url) {
    try {
      var email = Lampa.Storage.get('account_email', '');
      var uid = Lampa.Storage.get('lampac_unic_id', '');
      var token = getToken();

      if (email) url = addParam(url, 'account_email', email);
      if (uid) url = addParam(url, 'uid', uid);
      if (token) url = addParam(url, 'token', token);
    } catch (e) {}

    return url;
  }

  function requestHeaders() {
    var h = {};
    try {
      var aes = Lampa.Storage.get('aesgcmkey', '');
      if (aes) h['X-Kit-AesGcm'] = aes;
    } catch (e) {}

    var token = getToken();
    if (token) {
      h['X-Lampac-Token'] = token;
      h['X-Alpac-Token'] = token;
    }

    return h;
  }

  function showError(text) {
    try {
      Lampa.Noty.show(text);
    } catch (e) {
      log(text);
    }
  }

  function loading(start) {
    try {
      if (!Lampa.Loading) return;
      if (start) Lampa.Loading.start();
      else Lampa.Loading.stop();
    } catch (e) {}
  }

  function absoluteStream(host, value) {
    value = String(value || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;

    var base = host.replace(/\/$/, '');
    if (value.charAt(0) === '/') return base + value;

    // ALPAC /lite/trailer currently returns the encrypted proxy token itself
    // on some builds rather than a complete /proxy/... URL.
    if (value.indexOf('proxy/') === 0) return base + '/' + value;
    return base + '/proxy/' + value;
  }

  function playResolved(title, row, stream) {
    var playItem = {
      title: title,
      url: stream,
      stream: stream,
      quality: row && (row.quality || row.qualitys),
      qualitys: row && (row.qualitys || row.quality),
      duration: row && row.duration,
      hls_manifest_timeout: row && row.hls_manifest_timeout || 180000,
      __alpac_trailer_resolved: true
    };

    if (row && row.audio) playItem.audio = row.audio;
    if (row && row.dash) playItem.dash = row.dash;

    originalPlay.call(Lampa.Player, playItem);

    try {
      if (originalPlaylist) originalPlaylist.call(Lampa.Player, [playItem]);
    } catch (e) {}
  }

  function resolveViaYoutube(host, id, title, onDone) {
    var url = host + 'lite/youtube?videoID=' + encodeURIComponent(id) +
      '&title=' + encodeURIComponent(title) + '&rjson=true';

    url = authenticatedUrl(url);

    var net = new Lampa.Reguest();
    net.timeout(120000);

    net.silent(
      url,
      function (json) {
        var row = json && json.data && json.data.length ? json.data[0] : null;
        var stream = row && (row.stream || row.url);

        if (stream) {
          onDone(true, row, absoluteStream(host, stream));
        } else {
          onDone(false, json || null, '');
        }
      },
      function (err) {
        onDone(false, err || null, '');
      },
      false,
      { headers: requestHeaders() }
    );
  }

  function resolveAndPlay(item) {
    var id = youtubeId(item);
    if (!id) {
      return originalPlay.call(Lampa.Player, item);
    }

    var host = detectAlpacHost();
    var title = item.title || 'Трейлер';

    // ALPAC has a dedicated trailer resolver for exactly this scenario:
    // TMDB YouTube id -> yt-dlp -> a stream that Lampa can play.
    var trailerUrl = authenticatedUrl(
      host + 'lite/trailer?id=' + encodeURIComponent(id)
    );

    var net = new Lampa.Reguest();
    net.timeout(120000);
    loading(true);

    net.silent(
      trailerUrl,
      function (json) {
        var direct = json && json.url ? absoluteStream(host, json.url) : '';

        if (direct) {
          loading(false);
          log('resolved via /lite/trailer', id, direct);
          playResolved(title, json, direct);
          return;
        }

        // Some ALPAC nodes may not have the trailer route working even though
        // the generic YouTube resolver does. Try that before showing an error.
        log('/lite/trailer returned no URL, falling back to /lite/youtube', id);
        resolveViaYoutube(host, id, title, function (ok, row, stream) {
          loading(false);
          if (ok && stream) {
            log('resolved via /lite/youtube', id, stream);
            playResolved(title, row, stream);
          } else {
            var detail = row && row.error ? ': ' + row.error : '';
            showError('Трейлер: ALPAC не получил видео' + detail);
          }
        });
      },
      function (err) {
        // If the dedicated endpoint itself is unavailable, still try the
        // generic resolver used by ALPAC's YouTube search source.
        log('/lite/trailer request failed, fallback', err);
        resolveViaYoutube(host, id, title, function (ok, row, stream) {
          loading(false);
          if (ok && stream) {
            playResolved(title, row, stream);
          } else {
            var detail = row && row.error ? ': ' + row.error : '';
            showError('Трейлер: ошибка ALPAC' + detail);
          }
        });
      },
      false,
      { headers: requestHeaders() }
    );
  }

  function install() {
    if (installed) return true;
    if (!window.Lampa || !Lampa.Player || typeof Lampa.Player.play !== 'function' || !Lampa.Reguest) {
      return false;
    }

    originalPlay = Lampa.Player.play;
    originalPlaylist = Lampa.Player.playlist;

    Lampa.Player.play = function (item) {
      if (isStockTrailer(item)) {
        resolveAndPlay(item);
        return;
      }
      return originalPlay.apply(Lampa.Player, arguments);
    };

    installed = true;
    log('installed v' + VERSION, 'ALPAC:', detectAlpacHost());

    try {
      Lampa.Manifest.plugins = Lampa.Manifest.plugins || {};
      Lampa.Manifest.plugins['lampa_trailer_alpac_fix'] = {
        type: 'other',
        version: VERSION,
        name: 'Trailer ALPAC Fix',
        description: 'Штатная кнопка трейлера через ALPAC/yt-dlp для Tizen/MSX'
      };
    } catch (e) {}

    return true;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (install() || tries > 120) clearInterval(timer);
    }, 500);
  }
})();