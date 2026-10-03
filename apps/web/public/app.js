/* TurfSync board client.
 *
 * Renders the same markup the design prototype hand-wrote, from live API data.
 * Nothing here changes the design: every class name, element order and piece of
 * copy is carried over. What changed is where the numbers come from.
 */
(function () {
  'use strict';

  var TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v8M12 17.5v.01"/></svg>';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var state = { platforms: [], blockTaskCount: 0, date: null, board: null, selected: null, me: null, role: null, conflictCount: 0, taskCount: 0 };

  // The rail badge on "Alerts" counts anything needing a human right now —
  // an open conflict and an open sync task are the same kind of urgency, just
  // different causes, so they share one number rather than fighting for the
  // owner's attention with two.
  function updateAlertBadge() {
    var n = state.conflictCount + state.taskCount + state.blockTaskCount;
    var badge = $('alertBadge');
    badge.hidden = n === 0;
    badge.textContent = n;
    var bb = $('blockBadge');
    bb.hidden = state.blockTaskCount === 0;
    bb.textContent = state.blockTaskCount;
  }

  // What the signed-in role may reach. The API enforces this independently —
  // this only stops the client from asking for something it will be refused,
  // and from showing a rail button that leads to a 403.
  var VIEW_ROLES = {
    board: ['owner', 'staff'],
    conflicts: ['owner', 'staff'],
    blocking: ['owner', 'staff'],
    money: ['owner', 'partner'],
    setup: ['owner'],
  };

  function may(view) {
    return !state.role || VIEW_ROLES[view].indexOf(state.role) !== -1;
  }

  function api(path) {
    return fetch(path).then(function (r) {
      if (r.status === 401) {
        window.location.href = '/login.html';
        throw new Error('signed out');
      }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {
        var err = new Error(b.error || 'request failed (' + r.status + ')');
        err.status = r.status;
        throw err;
      });
      return r.json();
    });
  }

  // ---------------------------------------------------------------- topbar

  var DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  function renderTopbar(b) {
    $('venueName').textContent = b.venue.name;
    $('venueMeta').textContent = b.venue.locality + ', ' + b.venue.city + ' · ' +
      b.venue.courtCount + ' court' + (b.venue.courtCount === 1 ? '' : 's') + ' · ' +
      b.venue.plan.charAt(0).toUpperCase() + b.venue.plan.slice(1) + ' plan';

    $('dateLabel').innerHTML = esc(DAY_FMT.format(new Date(b.businessDate + 'T00:00:00Z'))) +
      ' <em>· play day</em>';
    $('dayPick').value = b.businessDate;
    renderFilters();

    // The day boundary sits inside the grid, so name the day it rolls into.
    var next = new Date(Date.parse(b.businessDate + 'T00:00:00Z') + 86400000);
    $('newdayLabel').textContent = '00:00 ' + DAY_FMT.format(next).split(',')[0];

    $('chanbar').innerHTML = b.channels.map(function (c) {
      var alert = c.status !== 'active' ||
        (c.sessionExpiresAt && Date.parse(c.sessionExpiresAt) - Date.now() < 3 * 86400000);
      var colour = alert ? 'var(--warn)' : 'var(--' + (c.uiKey === 'direct' ? 'ok' : c.uiKey) + ')';
      return '<div class="ch' + (alert ? ' alert' : '') + '">' +
        '<i class="ch-dot' + (alert ? ' pulse' : '') + '" style="background:' + colour + '"></i>' +
        '<span class="ch-name">' + esc(c.label) + '</span>' +
        '<span class="ch-meta">' + esc(ago(c.lastEventAt)) + '</span></div>';
    }).join('') + (b.device ? deviceChip(b.device) : '');
  }

  function deviceChip(d) {
    var quiet = Date.now() - Date.parse(d.receivedAt) > 20 * 60000;
    return '<div class="ch' + (quiet ? ' alert' : '') + '">' +
      '<i class="ch-dot' + (quiet ? ' pulse' : '') + '" style="background:' + (quiet ? 'var(--warn)' : 'var(--ok)') + '"></i>' +
      '<span class="ch-name">' + esc(d.label) + '</span>' +
      '<span class="ch-meta">' + (d.batteryPct != null ? d.batteryPct + '% · ' : '') +
      'heartbeat ' + esc(ago(d.receivedAt)) + '</span></div>';
  }

  function ago(ts) {
    if (!ts) return 'no events yet';
    var s = Math.round((Date.now() - Date.parse(ts)) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  // ---------------------------------------------------------------- board

  function renderBoard(b) {
    state.board = b;

    renderTopbar(b);

    var t = b.tiles;
    $('boardTiles').innerHTML = [
      tile('Bookings', t.bookings, 'across ' + b.channels.length + ' channels'),
      tile('Gross', t.grossLabel, 'before commission'),
      tile('Net to you', t.netLabel, t.commissionLabel + ' commission'),
      tile('Occupancy', t.occupancyPct + '%', '16:00–02:00, ' + b.venue.courtCount + ' courts'),
      tile('Blocks avoided', t.blocksAvoided, 'this week · ≈' + t.hoursSaved + ' hrs saved', true),
    ].join('');

    $('courtsCol').innerHTML = b.courts.map(function (c) {
      return '<div class="court"><b>' + esc(c.name) + '</b><span>' + esc(c.sport) + '</span>' +
        '<span class="util">' + c.slots + ' slot' + (c.slots === 1 ? '' : 's') + ' · ' + c.utilPct + '% full</span></div>';
    }).join('');

    $('nowlineHost').innerHTML = b.now
      ? '<div class="nowline" style="left:calc(var(--col) * ' + b.now.offsetCols + ')"><span class="t">' + esc(b.now.label) + '</span></div>'
      : '';

    var byCourt = {};
    b.courts.forEach(function (c) { byCourt[c.id] = []; });
    b.blocks.forEach(function (blk) { (byCourt[blk.courtId] || []).push(blockHtml(blk)); });
    b.conflicts.forEach(function (c) { (byCourt[c.courtId] || []).push(conflictHtml(c)); });
    b.maintenance.forEach(function (m) { (byCourt[m.courtId] || []).push(maintHtml(m)); });

    $('trackRows').innerHTML = b.courts.map(function (c) {
      return '<div class="row">' + byCourt[c.id].join('') + '</div>';
    }).join('');

    wireBlocks();

    if (state.selected && b.blocks.some(function (x) { return x.id === state.selected; })) {
      select(state.selected);
    } else {
      // Open on whatever is mid-sync — it is the one thing on the board that is
      // still moving. Failing that, the booking nearest to now.
      var seed = b.blocks.filter(function (x) { return x.syncing; })[0] || b.blocks[0];
      if (seed) select(seed.id); else { $('drawer').hidden = true; state.selected = null; }
    }
  }

  function tile(label, value, sub, star) {
    return '<div class="tile' + (star ? ' star' : '') + '"><span class="lbl">' + esc(label) +
      '</span><span class="tile-v">' + esc(value) + '</span><span class="tile-s">' + esc(sub) + '</span></div>';
  }

  function blockHtml(b) {
    var pips = b.pips.map(function (p) {
      var cls = p.state === 'verified' ? '' : p.state === 'fail' ? ' class="fail"' : ' class="pending"';
      return '<i' + cls + ' style="--pc:var(--' + p.uiKey + ')"></i>';
    }).join('');

    var meta = b.syncing
      ? '<span class="syncflag">SYNCING ' + b.verified + '/' + b.targetCount + '</span>'
      : esc(b.crossesMidnight ? b.startLabel + '–' + b.endLabel : b.startLabel + (b.amountLabel ? ' · ' + b.amountLabel : ''));

    return '<button class="blk ' + b.uiKey + (b.syncing ? ' syncing' : '') +
      '" style="grid-column:' + b.col + ' / span ' + b.span + '" data-b="' + esc(b.id) + '">' +
      '<span class="p">' + esc(b.platformLabel) + '</span>' +
      '<span class="n">' + esc(b.customer || 'Guest') + '</span>' +
      '<span class="m">' + meta + '<span class="pips">' + pips + '</span></span></button>';
  }

  function conflictHtml(c) {
    return '<button class="conf" style="grid-column:' + c.col + ' / span ' + c.span + '" data-goto="conflicts">' +
      '<span class="ct"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>Double-booked</span>' +
      c.sides.map(function (s) {
        return '<span class="cr"><i style="background:var(--' + s.uiKey + ')"></i>' + esc(s.name || 'Guest') + '</span>';
      }).join('') + '</button>';
  }

  function maintHtml(m) {
    return '<div class="maint" style="grid-column:' + m.col + ' / span ' + m.span + '">' + esc(m.reason) + '</div>';
  }

  function wireBlocks() {
    Array.prototype.forEach.call(document.querySelectorAll('.blk[data-b]'), function (el) {
      el.setAttribute('aria-pressed', 'false');
      el.addEventListener('click', function () { select(el.getAttribute('data-b')); });
    });
    var conf = document.querySelector('.conf[data-goto]');
    if (conf) conf.addEventListener('click', function () { show('conflicts'); });
  }

  // ---------------------------------------------------------------- drawer

  function select(id) {
    state.selected = id;
    Array.prototype.forEach.call(document.querySelectorAll('.blk[data-b]'), function (o) {
      o.setAttribute('aria-pressed', String(o.getAttribute('data-b') === id));
    });
    api('/api/bookings/' + id).then(renderDrawer).catch(function () {});
  }

  function renderDrawer(d) {
    $('drawer').hidden = false;
    var chip = $('drChip');
    chip.textContent = d.platformLabel + (d.uiKey === 'direct' ? ' · no commission' : '');
    chip.style.background = 'var(--' + d.uiKey + '-soft)';
    chip.style.color = 'var(--' + d.uiKey + ')';

    $('drName').textContent = d.customer || 'Guest';
    $('drSub').textContent = d.court + ' · ' +
      DAY_FMT.format(new Date(d.businessDate + 'T00:00:00Z')) + ' · ' + d.slotLabel;

    $('drPhone').textContent = d.phoneMasked || '—';
    $('drRef').textContent = d.ref;
    $('drSrc').textContent = d.sourceLabel;
    $('drPay').textContent = d.paymentLabel;
    $('drGross').textContent = d.grossLabel;
    $('drRateLbl').textContent = d.rateLabel;
    $('drComm').textContent = d.commissionLabel;
    $('drNet').textContent = d.netLabel;

    $('drFan').innerHTML = d.fan.map(function (f) {
      var colour = f.kind === 'src' ? 'var(--' + d.uiKey + ')'
        : f.kind === 'wait' ? 'var(--warn)'
        : f.kind === 'fail' ? 'var(--crit)' : 'var(--ok)';
      var mark = f.kind === 'wait'
        ? '<span class="mk hollow" style="--mc:' + colour + '"></span>'
        : '<span class="mk" style="--mc:' + colour + '">' +
          (f.kind === 'src' ? '' : f.kind === 'fail' ? BANG : TICK) + '</span>';
      var slow = f.latency !== '—' && parseFloat(f.latency) > 15;
      return '<li>' + mark + '<span class="tx"><b>' + esc(f.title) + '</b><small>' + esc(f.detail) +
        '</small></span><span class="lat' + (slow ? ' warnc' : '') + '">' + esc(f.latency) + '</span></li>';
    }).join('');
  }

  // ---------------------------------------------------------------- conflicts

  function renderConflicts(d) {
    state.conflictCount = d.open.length;
    updateAlertBadge();

    $('conflictOpen').innerHTML = d.open.length
      ? d.open.map(conflictCard).join('')
      : '<div class="panel"><div class="empty">No open conflicts. Every slot on the board is held by exactly one customer.</div></div>';

    $('resolvedBody').innerHTML = d.resolved.length
      ? d.resolved.map(function (r) {
          return '<tr><td class="mono">' + esc(r.when) + '</td><td>' + esc(r.slot) + '</td>' +
            '<td>' + esc(r.platforms || '—') + '</td><td>' + esc(r.cause || '—') + '</td>' +
            '<td>' + esc(r.resolution || '—') + '</td><td class="n">' + esc(r.costLabel) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="6" class="empty">Nothing resolved this week.</td></tr>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-resolve]'), function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.conflict-card');
        fetch('/api/conflicts/' + btn.getAttribute('data-conflict') + '/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keepBookingId: btn.getAttribute('data-resolve'),
            resolution: btn.getAttribute('data-resolution'),
          }),
        }).then(function (r) {
          if (!r.ok) return;
          card.querySelector('.resolved-note').style.display = 'flex';
          card.querySelector('.cc-actions').style.display = 'none';
          card.querySelector('.cc-h .badge').textContent = 'Resolved';
          refresh();
        });
      });
    });
  }

  function conflictCard(c) {
    var keep = c.sides.filter(function (s) { return s.recommended; })[0] || c.sides[0];
    var other = c.sides.filter(function (s) { return s !== keep; })[0];

    return '<div class="conflict-card">' +
      '<div class="cc-h"><span class="badge">Open conflict</span>' +
      '<h2>' + esc(c.court) + ' · ' + esc(c.slotLabel) + '</h2>' +
      '<span class="when mono">Detected ' + esc(c.detectedLabel) + ' · ' + c.minutesAgo + ' min ago</span></div>' +
      '<div class="cc-cause"><b>Why</b>' + esc(c.cause || 'Two platforms sold the same slot.') + '</div>' +
      '<div class="versus">' + sideHtml(keep, true) + '<div class="vs">VS</div>' + sideHtml(other, false) + '</div>' +
      (other ? '<div class="cc-msg"><span class="lbl">WhatsApp to ' + esc(firstName(other.name)) +
        ' — sends on resolve</span>Hi ' + esc(firstName(other.name)) + ', this is ' +
        esc(state.board ? state.board.venue.name : 'the venue') + '. ' + esc(c.court) + ' at ' +
        esc(c.slotLabel.split('–')[0]) + ' today was taken moments before your booking went through — sorry about that. ' +
        '<b>We can move you to another court at the same time</b> and we have held it for you. ' +
        'Reply YES and it is confirmed, or reply REFUND and ' + esc(other.paidLabel.replace(' online', '')) +
        ' is back in your account within 24 hours.</div>' : '') +
      '<div class="cc-actions">' +
      '<button class="btn primary" data-conflict="' + esc(c.id) + '" data-resolve="' + esc(keep.bookingId) +
      '" data-resolution="Kept ' + esc(keep.platformLabel) + ', offered the other customer an alternate slot">' +
      'Keep ' + esc(keep.platformLabel) + ', offer an alternate slot</button>' +
      (other ? '<button class="btn ghost" data-conflict="' + esc(c.id) + '" data-resolve="' + esc(other.bookingId) +
        '" data-resolution="Kept ' + esc(other.platformLabel) + ' instead">Keep ' + esc(other.platformLabel) + ' instead</button>' : '') +
      '<span class="spacer"></span>' +
      (other ? '<button class="btn danger" data-conflict="' + esc(c.id) + '" data-resolve="' + esc(keep.bookingId) +
        '" data-resolution="Refunded ' + esc(other.platformLabel) + ' customer">Refund ' +
        esc(firstName(other.name)) + ' ' + esc(other.paidLabel.replace(' online', '')) + '</button>' : '') +
      '</div>' +
      '<div class="resolved-note">' + TICKBIG() + 'Resolved. The released slot is back on sale, and the customer has been messaged.</div>' +
      '</div>';
  }

  function TICKBIG() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  }

  function sideHtml(s, win) {
    if (!s) return '<div class="side"></div>';
    return '<div class="side ' + (win ? 'win' : 'lose') + '">' +
      '<div class="who"><i style="background:var(--' + s.uiKey + ')"></i>' +
      '<span style="color:var(--' + s.uiKey + ')">' + esc(s.platformLabel) + '</span></div>' +
      '<h3>' + esc(s.name || 'Guest') + '</h3>' +
      '<div class="ph">' + esc(s.phoneMasked || '—') + '</div>' +
      '<div class="facts">' +
      fact('Booked at', s.bookedLabel) + fact('Paid', s.paidLabel) +
      fact('Bookings here', s.historyLabel) + fact('Blocked on', s.blockedLabel) +
      '</div>' +
      '<div class="verdict">' + (win
        ? TICKBIG() + 'Booked first · recommended keep'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 4v9M12 17.5v.01"/></svg>Needs a new slot or a refund') +
      '</div></div>';
  }

  function fact(k, v) { return '<div><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>'; }
  function firstName(n) { return String(n || 'there').split(' ')[0]; }

  // ---------------------------------------------------------------- sync tasks
  //
  // TurfSync never logs into Playo, Hudle or KheloMore itself — see
  // apps/api/src/blocking/worker.js. Every block or unblock it needs is a
  // task for a human to do in that platform's own app, confirmed here.

  function renderSyncTasks(d) {
    state.taskCount = d.tasks.length;
    updateAlertBadge();

    $('syncTasks').innerHTML = d.tasks.length
      ? d.tasks.map(taskCard).join('')
      : '';

    Array.prototype.forEach.call(document.querySelectorAll('[data-complete-task]'), function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Marking done…';
        fetch('/api/sync-tasks/' + btn.getAttribute('data-complete-task') + '/complete', { method: 'POST' })
          .then(function (r) {
            if (!r.ok) { btn.disabled = false; btn.textContent = 'Mark done'; return; }
            return refresh();
          });
      });
    });

    // Only present inside the Android wrapper (MainActivity's WebView) — a
    // plain browser tab has nothing to hand off to, so the button doesn't
    // render there at all rather than showing something that can't work.
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-platform]'), function (btn) {
      btn.addEventListener('click', function () {
        window.TurfSyncNative.openPlatformApp(btn.getAttribute('data-open-platform'));
      });
    });
  }

  // Only platforms with a known partner-app package can be jumped to
  // directly — see PlatformApps.kt on the Android side. Keep this list in
  // sync with that map; a platform missing here just gets no shortcut
  // button, not a broken one.
  var OPENABLE_PLATFORMS = { playo: true, hudle: true, khelomore: true, turfpro: true };

  function taskCard(t) {
    var overdue = t.overdue;
    var isUnblock = t.action === 'unblock';
    var verb = isUnblock ? 'Unblock' : 'Block';
    var instruction = isUnblock
      ? 'The booking that needed this was cancelled. Open the ' + esc(t.label) + ' app and release this slot yourself, then confirm below.'
      : 'Open the ' + esc(t.label) + ' app and block this slot yourself, then confirm below. TurfSync does not do this automatically — see the note on the Setup page.';
    var openButton = (window.TurfSyncNative && OPENABLE_PLATFORMS[t.platform])
      ? '<button class="btn" data-open-platform="' + esc(t.platform) + '">Open ' + esc(t.label) + '</button>'
      : '';

    return '<div class="task-card' + (overdue ? ' overdue' : '') + '">' +
      '<div class="tc-h"><span class="badge">' + (overdue ? 'Overdue' : verb + ' needed') + '</span>' +
      '<h2>' + esc(t.court) + ' on ' + esc(t.label) + '</h2>' +
      '<span class="when mono">' + esc(t.slot) + '</span></div>' +
      '<div class="tc-body">' + instruction + '</div>' +
      '<div class="tc-actions">' +
      openButton +
      '<button class="btn primary" data-complete-task="' + esc(t.id) + '">Mark done</button>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------- blocking board
  //
  // The automatic blocker (apps/slot-sync-aws) keeps its own record and serves
  // it at /status.json on the same address this dashboard is opened from.
  // Anything it could not finish by itself becomes a task here, with a
  // one-tap jump to the app and a "Mark done" once a person has fixed it.

  var BLOCK_RESULT = {
    awaiting_browser: ['Waiting for tap in TurfPro', 'warn'],
    blocked: ['Blocked', 'on'],
    skipped_already_blocked: ['Already blocked', 'off'],
    already_booked: ['Double booking', 'bad'],
    failed: ['Failed', 'bad'],
  };

  function blockTime(iso) {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function openAppButton(platform, label) {
    if (window.TurfSyncNative && OPENABLE_PLATFORMS[platform]) {
      return '<button class="btn" data-open-platform="' + esc(platform) + '">Open ' + esc(label) + '</button>';
    }
    // A plain browser: TurfPro is a web app on the same machine, so link to it.
    if (platform === 'turfpro') {
      return '<a class="btn" target="_blank" rel="noopener" href="http://' + esc(location.hostname) + '/admin/grounds">Open ' + esc(label) + '</a>';
    }
    return '';
  }

  function blockTaskCard(t) {
    var waiting = t.kind === 'awaiting_browser';
    var why = waiting
      ? (t.loginNeeded
          ? 'TurfSync is signed out of TurfPro. Tap Open ' + esc(t.label) + ' below and sign in once; the slot is then blocked automatically.'
          : 'TurfSync is blocking this slot in ' + esc(t.label) + ' for you. This clears itself once it is done.')
      : t.kind === 'already_booked'
      ? 'This slot is already booked on ' + esc(t.label) + ', so it cannot be blocked &mdash; two customers may have the same slot. Open the app and sort it out, then confirm below.'
      : 'The automatic block on ' + esc(t.label) + ' did not go through' + (t.detail ? ' (' + esc(t.detail) + ')' : '') + '. Open the app and block this slot yourself, then confirm below.';
    return '<div class="task-card ' + (t.kind === 'already_booked' || t.loginNeeded ? 'overdue' : '') + '">' +
      '<div class="tc-h"><span class="badge">' + (waiting ? (t.loginNeeded ? 'Login needed' : 'Tap to block') : t.kind === 'already_booked' ? 'Double booking' : 'Block failed') + '</span>' +
      '<h2>' + esc(t.court) + ' on ' + esc(t.label) + '</h2>' +
      '<span class="when mono">' + esc(t.slot) + '</span></div>' +
      '<div class="tc-body">' + why + '</div>' +
      '<div class="tc-actions">' + openAppButton(t.platform, t.label) +
      '<button class="btn primary" data-resolve-block="' + esc(t.id) + '">Mark done</button></div></div>';
  }

  function wireBlockButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-open-platform]'), function (btn) {
      btn.addEventListener('click', function () { window.TurfSyncNative.openPlatformApp(btn.getAttribute('data-open-platform')); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-resolve-block]'), function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Marking done…';
        fetch('/status/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: btn.getAttribute('data-resolve-block') }) })
          .then(function () { return refreshBlocking(); });
      });
    });
  }

  function appCard(a) {
    var c = a.counts;
    var head = '<div class="app-h"><h2>' + esc(a.label) + '</h2><span class="app-pill ' + (a.enabled ? 'on' : 'off') + '">' + (a.enabled ? 'Blocking on' : 'Switched off') + '</span>' +
      (a.enabled ? '<div class="app-stats"><span><b>' + c.blocked + '</b>blocked</span><span><b>' + c.doubleBooked + '</b>double bookings</span><span><b>' + c.failed + '</b>failed</span></div>' : '') + '</div>';
    if (!a.enabled) {
      return '<div class="app-card off">' + head + '<div class="app-off">Not blocking here for this test &mdash; no slot will be blocked on ' + esc(a.label) + '.</div></div>';
    }
    var rows = a.recent.length
      ? a.recent.map(function (b) {
          var r = BLOCK_RESULT[b.outcome] || [b.outcome, 'warn'];
          return '<tr><td class="mono">' + esc(blockTime(b.at)) + '</td><td>' + esc(b.ground) + '</td><td class="mono">' + esc(b.date) + '</td><td class="mono">' + esc(b.slot) + '</td>' +
            '<td><span class="app-pill ' + r[1] + '">' + esc(r[0]) + '</span>' + (b.detail ? ' <span class="note">' + esc(b.detail) + '</span>' : '') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty">No blocks yet. Send a booking message to this tablet&rsquo;s WhatsApp.</td></tr>';
    return '<div class="app-card">' + head + '<div class="tw"><table><thead><tr><th>When</th><th>Ground</th><th>Date</th><th>Slot</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  // A block that has been asked for but has not reached the tablet yet. Deliberately
  // not a task card and not in the Alerts badge: nobody needs to do anything about it
  // — it is here so "a booking landed, the block is moving" is visible rather than
  // looking exactly like an empty evening.
  var BLOCK_STAGE = {
    queued: 'Queued',
    leased: 'Blocking now',
    retrying: 'Retrying',
  };

  function stageAge(iso) {
    var mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    return Math.floor(mins / 60) + 'h ago';
  }

  function inProgressRow(p) {
    // Minutes, not seconds: a healthy job clears in well under one. Anything still
    // sitting here after a few is the worker not running, which is worth saying plainly.
    var stuck = p.state === 'queued' && Date.now() - new Date(p.since).getTime() > 5 * 60000;
    return '<tr><td class="mono">' + esc(stageAge(p.since)) + '</td>' +
      '<td>' + esc(p.sourceLabel) + (p.customer ? ' &middot; ' + esc(p.customer) : '') + '</td>' +
      '<td>' + esc(p.court) + '</td><td class="mono">' + esc(p.date) + '</td><td class="mono">' + esc(p.slot) + '</td>' +
      '<td><span class="app-pill ' + (stuck ? 'bad' : 'warn') + '">' + esc(BLOCK_STAGE[p.state] || p.state) +
      (p.attempts ? ' (try ' + p.attempts + ')' : '') + '</span>' +
      (stuck ? ' <span class="note">stuck &mdash; the block worker may not be running</span>' : '') +
      '</td></tr>';
  }

  function inProgressPanel(list) {
    if (!list || !list.length) return '';
    return '<div class="panel"><div class="panel-h"><h2>In progress</h2>' +
      '<span class="note">Bookings that have just landed and are being blocked on TurfPro right now. These clear themselves.</span></div>' +
      '<div class="tw"><table><thead><tr><th>Came in</th><th>Booking</th><th>Ground</th><th>Date</th><th>Slot</th><th>Stage</th></tr></thead>' +
      '<tbody>' + list.map(inProgressRow).join('') + '</tbody></table></div></div>';
  }

  function renderBlocking(d) {
    state.blockTaskCount = d.tasks.length;
    updateAlertBadge();
    var tasks = d.tasks.map(blockTaskCard).join('');
    $('blkTasks').innerHTML = tasks + inProgressPanel(d.inProgress);
    $('turfproTasks').innerHTML = tasks;
    $('blkApps').innerHTML = d.apps.map(appCard).join('');
    wireBlockButtons($('blkTasks'));
    wireBlockButtons($('turfproTasks'));
  }

  function refreshBlocking() {
    return fetch('/status.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(renderBlocking)
      .catch(function () {
        $('blkApps').innerHTML = '<div class="panel"><div class="empty">The blocking record is not reachable from this address. Open the dashboard through the TurfSync server address (port 8787).</div></div>';
      });
  }

  // ---------------------------------------------------------------- money

  var MONTH_FMT = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' });

  function renderMoney(d) {
    var monthName = MONTH_FMT.format(new Date(d.month + '-01T00:00:00Z'));
    $('moneyHeading').textContent = monthName + ' by platform';
    $('partnerHeading').textContent = 'Partner split · ' + monthName + ' net';

    var t = d.tiles;
    $('moneyTiles').innerHTML = [
      tile('Gross · ' + monthName, t.grossLabel, t.bookings + ' bookings'),
      tile('Commission paid', t.commissionLabel, t.blendedRateLabel),
      tile('Net earned', t.netLabel, 'after commission'),
      tile('Awaiting payout', t.awaitingLabel, t.openCycles + ' cycle' + (t.openCycles === 1 ? '' : 's') + ' open'),
      tile('Variance', t.varianceLabel, t.varianceLabel === '₹0' ? 'all settled' : 'under review'),
    ].join('');

    $('moneyBody').innerHTML = d.rows.map(function (r) {
      return '<tr><td><span class="pname"><i style="background:var(--' + r.uiKey + ')"' +
        (r.uiKey === 'direct' ? ';opacity:.55"' : '') + '></i>' + esc(r.label) + '</span></td>' +
        '<td class="n">' + r.bookings + '</td><td class="n">' + esc(r.grossLabel) + '</td>' +
        '<td class="n">' + esc(r.rateLabel) + '</td><td class="n">' + esc(r.commissionLabel) + '</td>' +
        '<td class="n">' + esc(r.netLabel) + '</td><td class="mono">' + esc(r.payoutCycle) + '</td>' +
        '<td><span class="pill ' + r.status.kind + '">' + esc(r.status.label) + '</span></td></tr>';
    }).join('');

    $('moneyFoot').innerHTML = '<tr><td>Total</td><td class="n">' + d.totals.bookings +
      '</td><td class="n">' + esc(d.totals.grossLabel) + '</td><td class="n">' + esc(d.totals.rateLabel) +
      '</td><td class="n">' + esc(d.totals.commissionLabel) + '</td><td class="n">' + esc(d.totals.netLabel) +
      '</td><td colspan="2"></td></tr>';

    var peak = d.occupancy.filter(function (o) { return o.peak; })[0];
    $('chart').setAttribute('aria-label', 'Occupancy by hour, all courts, ' + monthName + ': ' +
      d.occupancy.map(function (o) { return o.hourLabel + ':00 ' + o.pct + '%'; }).join(', ') + '.');
    $('chart').innerHTML = d.occupancy.map(function (o) {
      return '<div class="bar' + (o.peak ? ' peak' : '') + '"><div class="fill" style="height:' +
        Math.max(o.pct, 1) + '%"><span class="v">' + o.pct + '%</span></div></div>';
    }).join('');
    $('chartAxis').innerHTML = d.occupancy.map(function (o) { return '<span>' + o.hourLabel + '</span>'; }).join('');
    $('occNote').textContent = 'All courts, ' + monthName + '.';
    $('chartNote').textContent = peak
      ? peak.hourLabel + ':00 is your busiest hour at ' + peak.pct +
        '% occupancy. That is the band worth pricing against comparable turfs nearby.'
      : '';

    $('partners').innerHTML = d.partners.length
      ? d.partners.map(function (p) {
          return '<div><span class="pn">' + esc(p.name) + '</span><span class="pr">' +
            esc(p.shareLabel) + '</span><span class="pv">' + esc(p.amountLabel) + '</span></div>';
        }).join('')
      : '<div class="empty">No partners configured.</div>';
  }

  // ---------------------------------------------------------------- setup

  function renderSetup(d) {
    $('mapRows').innerHTML = d.courts.map(function (c) {
      return '<div class="maprow"><div class="canon"><b>' + esc(c.name) + '</b><span>' + esc(c.sport) + '</span></div>' +
        '<div class="maplist">' + c.chips.map(function (ch) {
          return ch.mapped
            ? '<span class="mapchip"><i style="background:var(--' + ch.uiKey + ')"></i><b>' +
              esc(ch.label) + '</b><span>' + esc(ch.external) + '</span></span>'
            : '<span class="mapchip unmapped">' + esc(ch.label) + ' — not listed yet</span>';
        }).join('') + '</div>' +
        '<span class="pill ' + c.status.kind + '">' + esc(c.status.label) + '</span></div>';
    }).join('');

    if (!d.device) {
      $('deviceGrid').innerHTML = '<div class="empty">No counter device paired yet.</div>';
      $('deviceApps').innerHTML = '';
      return;
    }

    $('deviceGrid').innerHTML = [
      dev('Heartbeat', d.device.heartbeatLabel, 'every 5 minutes'),
      dev('Battery', d.device.batteryPct + '%', 'unrestricted'),
      dev('Notification access', d.device.notificationAccess ? 'Granted' : 'Missing',
        d.device.notificationAccess ? 'all partner apps' : 'the board will miss bookings',
        d.device.notificationAccess ? 'var(--ok)' : 'var(--crit)'),
      dev('Queued offline', String(d.device.queuedOffline),
        d.device.queuedOffline ? 'waiting to send' : 'nothing waiting to send'),
    ].join('');

    $('deviceApps').innerHTML = d.device.apps.map(function (a) {
      return '<tr><td><span class="pname"><i style="background:var(--' + a.uiKey + ')"></i>' +
        esc(a.label) + '</span></td><td class="mono">' + esc(a.lastLabel) + '</td>' +
        '<td class="mono">' + a.today + '</td><td class="mono">' + esc(a.matchedLabel) + '</td>' +
        '<td><span class="pill ' + a.status.kind + '">' + esc(a.status.label) + '</span></td></tr>';
    }).join('');

    $('activityLogs').innerHTML = (d.logs || []).length
      ? d.logs.map(function (l) {
          var status = l.parse_status === 'failed' ? 'fail' : l.parse_status === 'template' || l.parse_status === 'fallback' ? 'ok' : 'warn';
          return '<tr><td class="mono">' + esc(ago(l.received_at)) + '</td>' +
            '<td>' + esc(l.platform || 'unknown') + '</td>' +
            '<td>' + esc(l.source_channel) + '</td>' +
            '<td><span class="pill ' + status + '">' + esc(l.parse_status) + '</span></td>' +
            '<td class="mono">' + esc(l.booking_id ? l.booking_id.slice(0, 8) : '—') + '</td>' +
            '<td class="mono">' + esc(l.parse_error || l.raw_text) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="6" class="empty">No notification activity yet.</td></tr>';
  }

  function dev(label, value, sub, colour) {
    return '<div><span class="lbl">' + esc(label) + '</span><div class="dv"' +
      (colour ? ' style="color:' + colour + '"' : '') + '>' + esc(value) + '</div>' +
      '<div class="ds">' + esc(sub) + '</div></div>';
  }

  // ---------------------------------------------------------------- board filters

  var FILTER_APPS = [
    ['turfpro', 'TurfPro'], ['playo', 'Playo'], ['khelomore', 'KheloMore'],
    ['hudle', 'Hudle'], ['district', 'District'], ['direct', 'Direct'],
  ];
  var UIKEY = { khelomore: 'khelo' };

  function renderFilters() {
    var all = state.platforms.length === 0;
    $('appFilters').innerHTML = '<span class="flabel">Bookings from</span>' +
      '<button class="fchip" data-app="" aria-pressed="' + all + '">All apps</button>' +
      FILTER_APPS.map(function (a) {
        var on = state.platforms.indexOf(a[0]) !== -1;
        return '<button class="fchip" data-app="' + a[0] + '" aria-pressed="' + on + '">' +
          '<i style="background:var(--' + (UIKEY[a[0]] || a[0]) + ')"></i>' + a[1] + '</button>';
      }).join('');
    Array.prototype.forEach.call($('appFilters').querySelectorAll('.fchip'), function (btn) {
      btn.addEventListener('click', function () {
        var app = btn.getAttribute('data-app');
        if (!app) state.platforms = [];
        else {
          var i = state.platforms.indexOf(app);
          if (i === -1) state.platforms.push(app); else state.platforms.splice(i, 1);
        }
        state.selected = null;
        refresh();
      });
    });
  }

  // ---------------------------------------------------------------- app logins
  //
  // Write-only. The server seals each login with the blocking worker's public
  // key and cannot open it again, so nothing here ever shows a saved username
  // or password — only that one exists, and how it has been used.

  var ACTION_LABEL = {
    credential_saved: 'Login saved', credential_removed: 'Login removed',
    login_attempt: 'Signing in', login_ok: 'Signed in', login_failed: 'Sign-in failed',
    session_reused: 'Reused session', read_slots: 'Read slots',
    block_slot: 'Blocked a slot', unblock_slot: 'Released a slot',
  };

  function useLine(u) {
    if (!u.logins && !u.sessionsReused && !u.blocks && !u.reads) return 'Not used yet.';
    return u.logins + ' sign-in' + (u.logins === 1 ? '' : 's') +
      (u.loginsFailed ? ' (' + u.loginsFailed + ' failed)' : '') + ' · ' +
      u.sessionsReused + ' session reuse' + (u.sessionsReused === 1 ? '' : 's') + ' · ' +
      u.reads + ' slot read' + (u.reads === 1 ? '' : 's') + ' · ' +
      u.blocks + ' block' + (u.blocks === 1 ? '' : 's') +
      (u.lastUsed ? ' · last used ' + ago(u.lastUsed) : '');
  }

  function renderLogins(d, act) {
    // No username/password here any more: TurfSync blocks TurfPro through the owner's own
    // signed-in session inside the tablet app, so this only shows whether that session is live.
    $('loginRows').innerHTML = d.apps.map(function (a) {
      return '<div class="login-row" data-login="' + esc(a.platform) + '">' +
        '<div class="who"><span><i class="ch-dot" style="display:inline-block;margin-right:6px;background:var(--' + esc(a.uiKey) + ')"></i>' + esc(a.label) + '</span>' +
        '<small class="login-state"></small></div>' +
        '<div class="acts"><button class="btn primary login-btn" type="button" hidden></button></div></div>';
    }).join('');
    updateLoginStatus();

    $('loginActivity').innerHTML = act.activity.length
      ? act.activity.map(function (r) {
          var bad = r.outcome !== 'ok';
          return '<tr><td class="mono">' + esc(ago(r.at)) + '</td><td>' + esc(r.label) + '</td><td>' + esc(ACTION_LABEL[r.action] || r.action) +
            '</td><td style="color:var(--' + (bad ? 'crit' : 'ok') + ')">' + (bad ? 'Failed' : 'OK') + '</td><td>' + esc(r.detail || '') +
            (r.actor && r.actor !== 'worker' ? ' <span class="note">by ' + esc(r.actor) + '</span>' : '') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty">No login has been used yet.</td></tr>';
  }

  /** Sets each app's status line from the tablet app (re-checked every few seconds, so it flips right after a sign-in). */
  function updateLoginStatus() {
    var native = window.TurfSyncNative;
    Array.prototype.forEach.call(document.querySelectorAll('#loginRows .login-row'), function (row) {
      var platform = row.getAttribute('data-login');
      var state = row.querySelector('.login-state');
      var btn = row.querySelector('.login-btn');
      var text, color, action = null;
      if (platform !== 'turfpro') {
        text = 'Blocking is switched off for this app'; color = 'var(--muted)';
      } else if (!native || !native.sessionStatus) {
        text = 'Open the TurfSync tablet app to check this login'; color = 'var(--muted)';
      } else if (native.sessionStatus(platform) === 'in') {
        text = 'Already logged in (Android app browser)'; color = 'var(--ok)'; action = 'Open TurfPro';
      } else {
        text = 'Login required'; color = 'var(--crit)'; action = 'Log in';
      }
      state.textContent = text;
      state.style.color = color;
      btn.hidden = !action;
      if (action) {
        btn.textContent = action;
        btn.onclick = function () { native.openPlatformApp(platform); };
      }
    });
  }
  setInterval(updateLoginStatus, 3000);

  function refreshLogins() {
    return Promise.all([api('/api/credentials'), api('/api/credentials/activity?limit=100')])
      .then(function (r) { renderLogins(r[0], r[1]); });
  }

  // ---------------------------------------------------------------- views

  var VIEWS = ['board', 'conflicts', 'blocking', 'money', 'setup'];

  function show(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.rail-btn'), function (t) {
      t.setAttribute('aria-selected', String(t.getAttribute('data-view') === name));
    });
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== name; });
    $('drawer').hidden = name !== 'board' ? true : !state.selected;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function refresh() {
    var qs = [];
    if (state.date) qs.push('date=' + state.date);
    if (state.platforms.length) qs.push('platforms=' + state.platforms.join(','));
    var q = qs.length ? '?' + qs.join('&') : '';
    var jobs = [];
    if (may('board'))     jobs.push(api('/api/board' + q).then(renderBoard));
    if (may('conflicts')) jobs.push(api('/api/conflicts').then(renderConflicts));
    if (may('conflicts')) jobs.push(api('/api/sync-tasks').then(renderSyncTasks));
    if (may('blocking'))  jobs.push(refreshBlocking());
    if (may('money'))     jobs.push(api('/api/money').then(renderMoney));
    if (may('setup'))     jobs.push(api('/api/setup').then(renderSetup));
    if (may('setup'))     jobs.push(refreshLogins());
    return Promise.all(jobs).catch(function (error) {
      if (error.message !== 'signed out') $('venueMeta').textContent = error.message;
    });
  }

  // ---------------------------------------------------------------- boot

  Array.prototype.forEach.call(document.querySelectorAll('.rail-btn[data-view]'), function (t) {
    t.addEventListener('click', function () { show(t.getAttribute('data-view')); });
  });

  $('signOut').addEventListener('click', function () {
    fetch('/auth/logout', { method: 'POST' }).then(function () {
      window.location.href = '/login.html';
    });
  });

  $('pairDevice').addEventListener('click', function () {
    var btn = $('pairDevice');
    btn.disabled = true;
    fetch('/api/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Counter tablet' }),
    }).then(function (r) { return r.json(); }).then(function (body) {
      btn.disabled = false;
      if (!body.token) return;
      // Shown once — the server only ever stores its hash, so this is the
      // only chance to see it. Enter it into the Android app's setup screen.
      $('pairResult').hidden = false;
      $('pairResult').innerHTML =
        '<b>Device token — shown once, copy it now</b>' +
        'Paste this into TurfSync Owner on the tablet, under Device setup.' +
        '<span class="tok">' + esc(body.token) + '</span>' +
        esc(body.note || '');
    });
  });

  $('drClose').addEventListener('click', function () {
    $('drawer').hidden = true;
    state.selected = null;
    Array.prototype.forEach.call(document.querySelectorAll('.blk[data-b]'), function (o) {
      o.setAttribute('aria-pressed', 'false');
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('drawer').hidden) $('drClose').click();
  });

  function shiftDay(n) {
    var base = state.date || (state.board && state.board.businessDate);
    if (!base) return;
    state.date = new Date(Date.parse(base + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    state.selected = null;
    refresh();
  }
  $('dayPick').addEventListener('change', function () {
    if (!$('dayPick').value) return;
    state.date = $('dayPick').value;
    state.selected = null;
    refresh();
  });
  $('dayToday').addEventListener('click', function () { state.date = null; state.selected = null; refresh(); });
  $('dayPrev').addEventListener('click', function () { shiftDay(-1); });
  $('dayNext').addEventListener('click', function () { shiftDay(1); });

  function applyRole() {
    Array.prototype.forEach.call(document.querySelectorAll('.rail-btn[data-view]'), function (t) {
      t.hidden = !may(t.getAttribute('data-view'));
    });
    var landing = VIEWS.filter(may)[0] || 'board';
    show(landing);
  }

  api('/auth/me').then(function (me) {
    state.me = me;
    var current = me.venues[0];
    state.role = current ? current.role : null;
    applyRole();
    boot();
  });

  function boot() {
  refresh().then(function () {
    var sc = $('scroller');
    if (sc && state.board && state.board.now) {
      // Bring the live hour into view without moving the page.
      sc.scrollLeft = Math.max(0, (state.board.now.offsetCols - 5) * 36);
    }
  });

  }

  // A booking landing on the counter tablet must appear here without a refresh.
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
    var pending = null;
    ws.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.type === 'hello') return;
      // Coalesce: a burst of blocks landing should repaint once.
      clearTimeout(pending);
      pending = setTimeout(refresh, 250);
    };
    ws.onclose = function () { setTimeout(connect, 3000); };
  }
  // A partner has no board to keep live, and the socket would only 1008 them.
  if (may('board')) connect();

  // The blocker runs outside this app, so poll its record rather than wait for a socket event.
  setInterval(function () { if (may('blocking')) refreshBlocking(); }, 5000);

  setInterval(function () {
    if (state.board) renderTopbar(state.board); // keep the "2m ago" labels honest
  }, 30000);
})();
