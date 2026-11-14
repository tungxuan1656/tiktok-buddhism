import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, TelegramError } from '../telegram.ts';

const photos = (count: number) => Array.from({ length: count }, (_, i) => ({
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, i]), name: `${String(i + 1).padStart(3, '0')}.png`, caption: `slide ${i + 1}`,
}));

test('photo transport uses fixed private owner, ordered multipart albums and sendPhoto for a singleton', async () => {
  for (const count of [1, 2, 10]) {
    const files = photos(count).map((file, i) => i % 2 ? { ...file, bytes: new Uint8Array([255, 216, 255, 224]), name: file.name.replace('.png', '.jpeg') } : file);
    let calls = 0;
    const telegram = new Telegram('fake-token', 123, async (url, init) => {
      calls++;
      assert.ok(String(url).endsWith(count === 1 ? '/sendPhoto' : '/sendMediaGroup'));
      assert.ok(init?.body instanceof FormData);
      const data = init.body;
      assert.equal(data.get('chat_id'), '123');
      assert.equal(data.get('document'), null);
      if (count === 1) {
        assert.equal(data.get('media'), null);
        assert.equal(data.get('caption'), files[0].caption);
      } else {
        assert.deepEqual(JSON.parse(String(data.get('media'))), files.map((file, i) => ({ type: 'photo', media: `attach://photo${i}`, caption: file.caption })));
      }
      for (let i = 0; i < count; i++) {
        const upload = data.get(count === 1 ? 'photo' : `photo${i}`) as File;
        assert.equal(upload.name, files[i].name);
        assert.equal(upload.type, files[i].name.endsWith('.png') ? 'image/png' : 'image/jpeg');
        assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), files[i].bytes);
      }
      const result = files.map((_, i) => ({ message_id: i + 10 }));
      return new Response(JSON.stringify({ ok: true, result: count === 1 ? result[0] : result }));
    });
    assert.deepEqual(await telegram.photos(files), files.map((_, i) => i + 10));
    assert.equal(calls, 1);
  }
});

test('JPEG uploads advertise their actual MIME and preserve original bytes for albums and documents', async () => {
  const bytes = new Uint8Array([255, 216, 255, 224]);
  const file = { bytes, name: '001.jpg', caption: 'slide 1' };
  let calls = 0;
  const telegram = new Telegram('fake-token', 123, async (url, init) => {
    calls++;
    const upload = (init?.body as FormData).get(String(url).endsWith('/sendDocument') ? 'document' : 'photo') as File;
    assert.equal(upload.type, 'image/jpeg');
    assert.equal(upload.name, '001.jpg');
    assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), bytes);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }));
  });
  assert.deepEqual(await telegram.photos([file]), [10]);
  assert.equal(await telegram.send(bytes, file.name, file.caption), 10);
  assert.equal(calls, 2);
});

test('photo limits fail before uploading and preserve the document option', async () => {
  let calls = 0;
  const telegram = new Telegram('fake-token', 123, async () => { calls++; throw new Error('must not upload'); });
  for (const files of [[], photos(11), [{ ...photos(1)[0], bytes: new Uint8Array(10_000_001) }]]) {
    await assert.rejects(telegram.photos(files), /10 MB.*\/files/);
  }
  assert.equal(calls, 0);
});

test('incomplete or invalid album acknowledgements remain ambiguous, with no automatic retry', async () => {
  const results = [null, undefined, [], [{ message_id: 1 }], [{ message_id: 1 }, { message_id: 1 }],
    [{ message_id: 1 }, { message_id: 0 }], [{ message_id: 1 }, { message_id: '2' }]];
  for (const result of results) {
    let calls = 0;
    const telegram = new Telegram('fake-token', 123, async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true, result }));
    });
    await assert.rejects(telegram.photos(photos(2)), error => error instanceof TelegramError && error.ambiguous);
    assert.equal(calls, 1);
  }
});
