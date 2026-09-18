(function () {
  'use strict';

  var VERSION = '1.3.0';
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

  function pickPipedStream(json) {
    var list = json && json.videoStreams ? json.videoStreams.slice() : [];

    // Progressive MP4 (videoOnly=false) is safest for Samsung/Tizen.
    var progressive = list.filter(function (x) {
      return x && x.url && x.videoOnly === false &&
        (!x.mimeType || String(x.mimeType).toLowerCase().indexOf('video/mp4') === 0);
    });

    if (!progressive.length) {
      progressive = list.filter(function (x) {
        return x && x.url && x.videoOnly === false;
      });
    }

    progressive.sort(function (a, b) {
      var ha = parseInt(a.height || 0, 10);
      var hb = parseInt(b.height || 0, 10);
      if (ha > 1080) ha = -1;
      if (hb > 1080) hb = -1;
      return hb - ha;
    });

    if (progressive.length) return String(progressive[0].url);

    // Last resorts supported by Lampa Player.
    if (json && json.hls) return String(json.hls);
    if (json && json.dash) return String(json.dash);

    return '';
  }

  function resolveAndPlay(item) {
    var id = youtubeId(item);
    if (!id) {
      return originalPlay.call(Lampa.Player, item);
    }

    var host = detectAlpacHost();
    var title = item.title || 'Трейлер';
    var finished = false;
    var pending = 0;
    var errors = [];

    loading(true);

    function finish(row, stream, source) {
      if (finished || !stream) return;
      finished = true;
      loading(false);
      log('resolved via ' + source, id, stream);
      playResolved(title, row || {}, stream);
    }

    function failed(source, detail) {
      if (finished) return;
      errors.push(source + (detail ? ': ' + detail : ''));
      pending--;
      if (pending <= 0) {
        finished = true;
        loading(false);
        log('all resolvers failed', errors);
        showError('Трейлер: не удалось получить видео');
      }
    }

    function getJSON(url, timeout, headers, source, success) {
      pending++;
      var net = new Lampa.Reguest();
      net.timeout(timeout);
      net.silent(
        url,
        function (json) {
          if (finished) return;
          try {
            if (success(json)) return;
          } catch (e) {
            log(source + ' parse error', e);
          }
          failed(source, json && json.error ? json.error : '');
        },
        function (err) {
          failed(source, 'network');
        },
        false,
        headers ? { headers: headers } : undefined
      );
    }

    // 1) ALPAC dedicated trailer resolver.
    getJSON(
      authenticatedUrl(host + 'lite/trailer?id=' + encodeURIComponent(id)),
      25000,
      requestHeaders(),
      'ALPAC',
      function (json) {
        var stream = json && json.url ? absoluteStream(host, json.url) : '';
        if (!stream) return false;
        finish(json, stream, 'ALPAC');
        return true;
      }
    );

    // 2) Piped public APIs. Their /streams/:id response returns proxied stream URLs.
    [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.leptons.xyz',
      'https://pipedapi.nosebs.ru'
    ].forEach(function (apiHost) {
      getJSON(
        apiHost + '/streams/' + encodeURIComponent(id),
        15000,
        null,
        'Piped ' + apiHost,
        function (json) {
          var stream = pickPipedStream(json);
          if (!stream) return false;
          finish({
            title: title,
            duration: json && json.duration ? parseInt(json.duration, 10) : 0
          }, stream, 'Piped');
          return true;
        }
      );
    });

    // 3) Current public Invidious instances. Run in parallel, not one after another.
    [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://yt.chocolatemoo53.com'
    ].forEach(function (apiHost) {
      getJSON(
        apiHost + '/api/v1/videos/' + encodeURIComponent(id) + '?local=true',
        15000,
        null,
        'Invidious ' + apiHost,
        function (json) {
          var stream = pickInvidiousStream(json);
          if (!stream) return false;
          finish({
            title: title,
            duration: json && json.lengthSeconds ? parseInt(json.lengthSeconds, 10) : 0
          }, stream, 'Invidious');
          return true;
        }
      );
    });
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