/* Onboarding.
 *
 * The seed script used to do this work: create courts, then tell us what each
 * marketplace calls them. That mapping is the one piece of setup nobody else
 * can do for the owner, and getting it wrong blocks the wrong pitch — which is
 * why the copy is blunt about typing the label exactly as the app shows it.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var PLATFORMS = [
    { key: 'playo', label: 'Playo', ui: 'playo', eg: 'Turf A' },
    { key: 'khelomore', label: 'KheloMore', ui: 'khelo', eg: 'Ground 1' },
    { key: 'hudle', label: 'Hudle', ui: 'hudle', eg: '5-a-side Main' },
    { key: 'district', label: 'District', ui: 'district', eg: 'Football Court 1' },
  ];

  var courts = [];

  function fail(message) {
    var el = $('error');
    el.textContent = message;
    el.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      if (r.status === 401) { window.location.href = '/login.html'; throw new Error('signed out'); }
      if (r.status === 204) return null;
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Something went wrong.');
        return d;
      });
    });
  }

  var post = function (path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  // ---------------------------------------------------------------- step 1

  function renderCourts() {
    $('courtList').innerHTML = courts.length
      ? courts.map(function (c) {
          return '<div class="courtrow"><b>' + esc(c.name) + '</b><span>' + esc(c.sport) + '</span>' +
            '<button class="rm" data-id="' + esc(c.id) + '" aria-label="Remove ' + esc(c.name) + '">&times;</button></div>';
        }).join('')
      : '<div class="empty">No courts yet. Add your first one below.</div>';

    Array.prototype.forEach.call($('courtList').querySelectorAll('.rm'), function (b) {
      b.addEventListener('click', function () {
        api('/api/courts/' + b.getAttribute('data-id'), { method: 'DELETE' })
          .then(load)
          .catch(function (e) { fail(e.message); });
      });
    });

    $('toStep2').disabled = courts.length === 0;
  }

  $('addCourt').addEventListener('click', function () {
    var name = $('courtName').value.trim();
    if (!name) return fail('Give the court a name.');
    $('error').hidden = true;

    post('/api/courts', { name: name, sport: $('courtSport').value.trim() })
      .then(function () {
        $('courtName').value = '';
        $('courtSport').value = '';
        $('courtName').focus();
        return load();
      })
      .catch(function (e) { fail(e.message); });
  });

  // Enter in either field adds the court — this screen is a lot of typing.
  ['courtName', 'courtSport'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('addCourt').click(); }
    });
  });

  // ---------------------------------------------------------------- step 2

  function renderMapping() {
    $('mapPanel').innerHTML = courts.map(function (c) {
      return '<div class="mapcourt"><h3>' + esc(c.name) + '</h3><p>' + esc(c.sport) + '</p>' +
        '<div class="mapgrid">' + PLATFORMS.map(function (p) {
          var existing = (c.mappings || {})[p.key] || '';
          return '<label><span><i style="background:var(--' + p.ui + ')"></i>' + esc(p.label) + '</span>' +
            '<input data-court="' + esc(c.id) + '" data-platform="' + p.key + '" ' +
            'placeholder="' + esc(p.eg) + '" value="' + esc(existing) + '"></label>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function saveMappings() {
    var byCourt = {};
    Array.prototype.forEach.call($('mapPanel').querySelectorAll('input'), function (input) {
      var court = input.getAttribute('data-court');
      byCourt[court] = byCourt[court] || {};
      byCourt[court][input.getAttribute('data-platform')] = input.value.trim();
    });

    return Promise.all(Object.keys(byCourt).map(function (courtId) {
      return api('/api/courts/' + courtId + '/mappings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mappings: byCourt[courtId] }),
      });
    }));
  }

  function step(n) {
    $('step1').hidden = n !== 1;
    $('step2').hidden = n !== 2;
    $('s1').className = 'step ' + (n === 1 ? 'on' : 'done');
    $('s2').className = 'step ' + (n === 2 ? 'on' : '');
    $('error').hidden = true;
    if (n === 2) renderMapping();
    window.scrollTo({ top: 0 });
  }

  $('toStep2').addEventListener('click', function () { step(2); });
  $('backTo1').addEventListener('click', function () { step(1); });

  // Leaving without mapping is a real choice: the board still shows walk-ins
  // and the Setup tab will keep saying which courts are unmapped.
  $('skipMapping').addEventListener('click', function () { window.location.href = '/'; });

  $('finish').addEventListener('click', function () {
    $('finish').disabled = true;
    saveMappings()
      .then(function () { window.location.href = '/'; })
      .catch(function (e) { fail(e.message); $('finish').disabled = false; });
  });

  // ---------------------------------------------------------------- boot

  function load() {
    return api('/api/setup').then(function (d) {
      courts = d.courts.map(function (c) {
        var mappings = {};
        (c.chips || []).forEach(function (ch) { if (ch.mapped) mappings[ch.platform] = ch.external; });
        return { id: c.id, name: c.name, sport: c.sport, mappings: mappings };
      });
      renderCourts();
    });
  }

  api('/auth/me')
    .then(function (me) {
      if (me.venues[0]) $('venueName').textContent = me.venues[0].name;
      return load();
    })
    .catch(function (e) { if (e.message !== 'signed out') fail(e.message); });
})();
