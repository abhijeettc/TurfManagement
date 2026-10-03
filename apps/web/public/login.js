/* Sign in / sign up.
 *
 * One form in two modes. Signup creates the account and its first venue in the
 * same request — an account with no venue has no screen in this product that
 * means anything, so there is no state where one exists without the other.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var mode = 'login';

  function setMode(next) {
    mode = next;
    var signup = mode === 'signup';
    $('signupFields').hidden = !signup;
    $('title').textContent = signup ? 'Create your account' : 'Sign in';
    $('subtitle').textContent = signup
      ? 'Two minutes to a board with every app on it.'
      : 'One calendar for every app your turf is listed on.';
    $('submit').textContent = signup ? 'Create account' : 'Sign in';
    $('altText').textContent = signup ? 'Already have an account?' : 'New here?';
    $('toggle').textContent = signup ? 'Sign in' : 'Create an account';
    $('password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('error').hidden = true;
  }

  $('toggle').addEventListener('click', function () {
    setMode(mode === 'login' ? 'signup' : 'login');
  });

  function fail(message) {
    var el = $('error');
    el.textContent = message;
    el.hidden = false;
  }

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('error').hidden = true;
    $('submit').disabled = true;

    var isSignup = mode === 'signup';
    var body = { email: $('email').value.trim(), password: $('password').value };
    if (isSignup) {
      body.name = $('name').value.trim();
      body.phone = $('phone').value.trim();
      body.venueName = $('venueName').value.trim();
      body.locality = $('locality').value.trim();
      body.city = $('city').value.trim();
    }

    fetch(isSignup ? '/auth/signup' : '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again.');
          return d;
        });
      })
      .then(function (d) {
        // A brand-new venue has no courts and no mappings, so the board would
        // be an empty grid. Send them to onboarding instead.
        window.location.href = d.next === 'onboarding' ? '/onboarding.html' : '/';
      })
      .catch(function (err) {
        fail(err.message);
        $('submit').disabled = false;
      });
  });

  // Development quick sign-in. The server only offers it when it is switched on
  // (and never in production); clicking the label fills the form so it is clear
  // who is being signed in, then the server opens the session itself.
  fetch('/auth/dev-login-options')
    .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
    .then(function (o) {
      if (!o.enabled) return;
      $('quickAdmin').textContent = o.label;
      $('quick').hidden = false;
      $('quickAdmin').addEventListener('click', function () {
        setMode('login');
        $('email').value = o.email;
        $('password').value = '••••••••';
        $('submit').disabled = true;
        fetch('/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              if (!r.ok) throw new Error(d.error || 'Quick sign-in failed.');
              return d;
            });
          })
          .then(function () { window.location.href = '/'; })
          .catch(function (err) {
            $('password').value = '';
            fail(err.message);
            $('submit').disabled = false;
          });
      });
    })
    .catch(function () {});

  // Already signed in? Skip the form.
  fetch('/auth/me')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d) window.location.href = d.next === 'onboarding' ? '/onboarding.html' : '/';
    })
    .catch(function () {});

  setMode('login');
})();
