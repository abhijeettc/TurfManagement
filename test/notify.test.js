import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sendWhatsApp } from '../apps/api/src/notify.js';

const ENV_KEYS = ['WHATSAPP_PROVIDER', 'GUPSHUP_API_KEY', 'GUPSHUP_SOURCE_NUMBER', 'GUPSHUP_APP_NAME', 'GUPSHUP_TEMPLATE_IDS'];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) delete process.env[key];
      Object.assign(process.env, saved);
    });
}

test('unknown template throws', async () => {
  await assert.rejects(() => sendWhatsApp('+919812345678', 'nonexistent', {}), /unknown WhatsApp template/);
});

test('console provider (default) logs and does not deliver', async () =>
  withEnv({}, async () => {
    const logged = mock.method(console, 'log', () => {});
    try {
      const result = await sendWhatsApp('+919812345678', 'booking_alert', {
        platform: 'Playo',
        customer: 'Rohit',
        court: 'Court 1',
        slot: '19:00–20:00',
        amount: '₹1,100',
      });
      assert.deepEqual(result, { delivered: false, provider: 'console' });
      assert.equal(logged.mock.callCount(), 1);
      assert.match(logged.mock.calls[0].arguments[0], /Rohit/);
    } finally {
      logged.mock.restore();
    }
  }));

test('unconfigured provider throws', async () =>
  withEnv({ WHATSAPP_PROVIDER: 'aisensy' }, async () => {
    await assert.rejects(
      () => sendWhatsApp('+919812345678', 'booking_alert', { platform: 'Playo', court: 'Court 1', slot: '19:00–20:00' }),
      /provider "aisensy" not implemented/,
    );
  }));

test('gupshup provider without a template id configured throws, not a silent no-op', async () =>
  withEnv(
    {
      WHATSAPP_PROVIDER: 'gupshup',
      GUPSHUP_API_KEY: 'key',
      GUPSHUP_SOURCE_NUMBER: '911234567890',
      GUPSHUP_APP_NAME: 'TurfSync',
    },
    async () => {
      await assert.rejects(
        () => sendWhatsApp('+919812345678', 'booking_alert', { platform: 'Playo', court: 'Court 1', slot: '19:00–20:00' }),
        /no Gupshup template id configured/,
      );
    },
  ));

test('gupshup provider without credentials throws', async () =>
  withEnv(
    { WHATSAPP_PROVIDER: 'gupshup', GUPSHUP_TEMPLATE_IDS: JSON.stringify({ booking_alert: 'tmpl-1' }) },
    async () => {
      await assert.rejects(
        () => sendWhatsApp('+919812345678', 'booking_alert', { platform: 'Playo', court: 'Court 1', slot: '19:00–20:00' }),
        /GUPSHUP_API_KEY, GUPSHUP_SOURCE_NUMBER and GUPSHUP_APP_NAME/,
      );
    },
  ));

test('malformed GUPSHUP_TEMPLATE_IDS throws a clear error', async () =>
  withEnv(
    {
      WHATSAPP_PROVIDER: 'gupshup',
      GUPSHUP_API_KEY: 'key',
      GUPSHUP_SOURCE_NUMBER: '911234567890',
      GUPSHUP_APP_NAME: 'TurfSync',
      GUPSHUP_TEMPLATE_IDS: 'not json',
    },
    async () => {
      await assert.rejects(
        () => sendWhatsApp('+919812345678', 'booking_alert', { platform: 'Playo', court: 'Court 1', slot: '19:00–20:00' }),
        /GUPSHUP_TEMPLATE_IDS must be valid JSON/,
      );
    },
  ));

test('gupshup provider sends a positional-params request and reports delivered on success', async () =>
  withEnv(
    {
      WHATSAPP_PROVIDER: 'gupshup',
      GUPSHUP_API_KEY: 'test-key',
      GUPSHUP_SOURCE_NUMBER: '911234567890',
      GUPSHUP_APP_NAME: 'TurfSync',
      GUPSHUP_TEMPLATE_IDS: JSON.stringify({ block_task: 'tmpl-block-task' }),
    },
    async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.gupshup.io/wa/api/v1/template/msg');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.apikey, 'test-key');
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('channel'), 'whatsapp');
        assert.equal(body.get('source'), '911234567890');
        assert.equal(body.get('destination'), '919812345678');
        assert.equal(body.get('src.name'), 'TurfSync');
        assert.deepEqual(JSON.parse(body.get('template')), {
          id: 'tmpl-block-task',
          params: ['Hudle', 'Court 1', '19:00–20:00'],
        });
        return new Response(JSON.stringify({ status: 'submitted', messageId: 'abc' }), { status: 202 });
      });
      try {
        const result = await sendWhatsApp('+919812345678', 'block_task', {
          platform: 'Hudle',
          court: 'Court 1',
          slot: '19:00–20:00',
        });
        assert.equal(result.delivered, true);
        assert.equal(result.provider, 'gupshup');
        assert.equal(result.raw.messageId, 'abc');
        assert.equal(fetchMock.mock.callCount(), 1);
      } finally {
        fetchMock.mock.restore();
      }
    },
  ));

test('gupshup provider throws on a non-2xx response, including the response body', async () =>
  withEnv(
    {
      WHATSAPP_PROVIDER: 'gupshup',
      GUPSHUP_API_KEY: 'test-key',
      GUPSHUP_SOURCE_NUMBER: '911234567890',
      GUPSHUP_APP_NAME: 'TurfSync',
      GUPSHUP_TEMPLATE_IDS: JSON.stringify({ block_task: 'tmpl-block-task' }),
    },
    async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () =>
        new Response(JSON.stringify({ message: 'invalid destination' }), { status: 400 }));
      try {
        await assert.rejects(
          () => sendWhatsApp('+919812345678', 'block_task', { platform: 'Hudle', court: 'Court 1', slot: '19:00–20:00' }),
          /Gupshup send failed \(400\).*invalid destination/,
        );
      } finally {
        fetchMock.mock.restore();
      }
    },
  ));

test('missing optional vars become a placeholder, not "undefined", in Gupshup params', async () =>
  withEnv(
    {
      WHATSAPP_PROVIDER: 'gupshup',
      GUPSHUP_API_KEY: 'test-key',
      GUPSHUP_SOURCE_NUMBER: '911234567890',
      GUPSHUP_APP_NAME: 'TurfSync',
      GUPSHUP_TEMPLATE_IDS: JSON.stringify({ booking_alert: 'tmpl-booking' }),
    },
    async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
        const body = new URLSearchParams(init.body);
        const { params } = JSON.parse(body.get('template'));
        assert.deepEqual(params, ['Playo', '-', 'Court 1', '19:00–20:00', '-']);
        return new Response(JSON.stringify({}), { status: 202 });
      });
      try {
        await sendWhatsApp('+919812345678', 'booking_alert', {
          platform: 'Playo',
          customer: null,
          court: 'Court 1',
          slot: '19:00–20:00',
          amount: null,
        });
      } finally {
        fetchMock.mock.restore();
      }
    },
  ));
