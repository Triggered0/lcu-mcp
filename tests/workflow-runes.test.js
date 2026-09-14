import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRunePage } from '../src/workflow/runes.js';

function createMockLcu({ pages = [], putStatus = 200, postStatus = 201 } = {}) {
  const calls = {
    gets: [],
    puts: [],
    posts: []
  };

  return {
    calls,
    get: async (path) => {
      calls.gets.push(path);
      if (path === '/lol-perks/v1/pages') {
        return { status: 200, body: pages };
      }
      return { status: 404, body: null };
    },
    request: async (method, path, body) => {
      if (method === 'PUT') {
        calls.puts.push({ path, body });
        if (putStatus >= 400) return { status: putStatus, body: { message: 'PUT failed' } };
        const id = Number(path.split('/').pop());
        return { status: putStatus, body: { id, ...body } };
      }
      if (method === 'POST') {
        calls.posts.push({ path, body });
        if (postStatus >= 400) return { status: postStatus, body: { message: 'POST failed' } };
        return { status: postStatus, body: { id: 20, ...body } };
      }
      return { status: 200, body: null };
    }
  };
}

test('setRunePage throws when lcu client is missing or invalid', async () => {
  await assert.rejects(
    async () => setRunePage(null, { primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [8010] }),
    /LCU client is required/i
  );
});

test('setRunePage throws when primaryStyleId is missing or invalid', async () => {
  const lcu = createMockLcu();
  await assert.rejects(
    async () => setRunePage(lcu, { subStyleId: 8100, selectedPerkIds: [8010] }),
    /primaryStyleId is required and must be a number/i
  );
  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 'invalid', subStyleId: 8100, selectedPerkIds: [8010] }),
    /primaryStyleId is required and must be a number/i
  );
});

test('setRunePage throws when subStyleId is missing or invalid', async () => {
  const lcu = createMockLcu();
  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 8000, selectedPerkIds: [8010] }),
    /subStyleId is required and must be a number/i
  );
  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 8000, subStyleId: 'bad', selectedPerkIds: [8010] }),
    /subStyleId is required and must be a number/i
  );
});

test('setRunePage throws when selectedPerkIds is missing or empty', async () => {
  const lcu = createMockLcu();
  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 8000, subStyleId: 8100 }),
    /selectedPerkIds is required and must be a non-empty array/i
  );
  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [] }),
    /selectedPerkIds is required and must be a non-empty array/i
  );
});

test('setRunePage updates existing editable page when replace is true', async () => {
  const existingPages = [
    { id: 100, name: 'Default', isEditable: false, current: false },
    { id: 101, name: 'Custom Page', isEditable: true, current: true }
  ];
  const lcu = createMockLcu({ pages: existingPages });

  const result = await setRunePage(lcu, {
    name: 'Conqueror Yasuo',
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [8010, 9111, 9104, 8299, 8143, 8105, 5008, 5008, 5002],
    replace: true
  });

  assert.equal(result.success, true);
  assert.equal(result.pageId, 101);
  assert.equal(result.name, 'Conqueror Yasuo');
  assert.equal(result.primaryStyleId, 8000);
  assert.equal(result.subStyleId, 8100);
  assert.deepEqual(result.selectedPerkIds, [8010, 9111, 9104, 8299, 8143, 8105, 5008, 5008, 5002]);
  assert.match(result.message, /rune page active/i);

  assert.equal(lcu.calls.puts.length, 1);
  assert.equal(lcu.calls.posts.length, 0);
  assert.equal(lcu.calls.puts[0].path, '/lol-perks/v1/pages/101');
  assert.equal(lcu.calls.puts[0].body.current, true);
});

test('setRunePage creates new page when no editable page is found', async () => {
  const existingPages = [
    { id: 100, name: 'Default 1', isEditable: false, current: true }
  ];
  const lcu = createMockLcu({ pages: existingPages });

  const result = await setRunePage(lcu, {
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [8010, 9111],
    replace: true
  });

  assert.equal(result.success, true);
  assert.equal(result.pageId, 20);
  assert.equal(result.name, 'Antigravity Runes');
  assert.equal(lcu.calls.posts.length, 1);
  assert.equal(lcu.calls.puts.length, 0);
  assert.equal(lcu.calls.posts[0].path, '/lol-perks/v1/pages');
  assert.equal(lcu.calls.posts[0].body.isEditable, true);
  assert.equal(lcu.calls.posts[0].body.current, true);
});

test('setRunePage creates new page when replace is false even if editable page exists', async () => {
  const existingPages = [
    { id: 101, name: 'Custom Page', isEditable: true, current: true }
  ];
  const lcu = createMockLcu({ pages: existingPages });

  const result = await setRunePage(lcu, {
    name: 'New Page',
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [8010],
    replace: false
  });

  assert.equal(result.success, true);
  assert.equal(result.pageId, 20);
  assert.equal(result.name, 'New Page');
  assert.equal(lcu.calls.posts.length, 1);
  assert.equal(lcu.calls.puts.length, 0);
});

test('setRunePage throws when PUT fails', async () => {
  const existingPages = [{ id: 101, isEditable: true, current: true }];
  const lcu = createMockLcu({ pages: existingPages, putStatus: 500 });

  await assert.rejects(
    async () => setRunePage(lcu, { primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [8010] }),
    /failed to update rune page/i
  );
});
