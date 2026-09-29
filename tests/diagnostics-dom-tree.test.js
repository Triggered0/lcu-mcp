import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  parseDomHierarchy,
  buildDomInspectorScript,
  inspectDomTree
} from '../src/diagnostics/dom_tree.js';
import { registerDomTreeTool } from '../src/tools/cdp_dom_tree.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-dom-tree', version: '1.0.0' });
  registerDomTreeTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('buildDomInspectorScript generates valid JS snippet', () => {
  const script = buildDomInspectorScript({ includeOverlaysOnly: false, maxDepth: 5 });
  assert.ok(typeof script === 'string');
  assert.ok(script.includes('rcp-fe-lol-'));
  assert.ok(script.includes('lol-uikit-dialog-frame'));
  assert.ok(script.includes('pointerEvents'));
  // Verify it parses as valid JS syntax
  assert.doesNotThrow(() => new Function(script));
});

test('parseDomHierarchy extracts active modal containers with title, z-index, visibility, and buttons', () => {
  const rawData = {
    modals: [
      {
        tag: 'lol-uikit-dialog-frame',
        id: 'quit-modal',
        className: 'modal-container active',
        title: 'Exit Game',
        zIndex: 1000,
        visible: true,
        buttons: [
          { tag: 'button', text: 'Cancel', className: 'btn-secondary', disabled: false },
          { tag: 'button', text: 'Quit', className: 'btn-primary', disabled: false }
        ]
      },
      {
        tag: 'div',
        id: 'ember-dialog',
        className: 'ember-view active modal-wrapper',
        title: null,
        zIndex: 500,
        visible: true,
        buttons: []
      }
    ],
    overlays: [],
    viewport: {
      activePlugin: 'rcp-fe-lol-champ-select',
      currentScreen: 'rcp-fe-lol-champ-select',
      routeName: 'champ-select',
      documentTitle: 'League of Legends'
    }
  };

  const result = parseDomHierarchy(rawData);
  assert.equal(result.activeModals.length, 2);
  assert.equal(result.activeModals[0].tag, 'lol-uikit-dialog-frame');
  assert.equal(result.activeModals[0].title, 'Exit Game');
  assert.equal(result.activeModals[0].zIndex, 1000);
  assert.equal(result.activeModals[0].visible, true);
  assert.equal(result.activeModals[0].buttons.length, 2);
  assert.equal(result.activeModals[0].buttons[1].text, 'Quit');

  // Verify sorted by z-index descending
  assert.equal(result.activeModals[0].zIndex, 1000);
  assert.equal(result.activeModals[1].zIndex, 500);
});

test('parseDomHierarchy detects invisible overlay backdrops blocking clicks with opacity 0 and pointer-events all', () => {
  const rawData = {
    modals: [],
    overlays: [
      {
        tag: 'lol-uikit-full-page-backdrop',
        id: 'stuck-backdrop',
        className: 'fullscreen-overlay',
        zIndex: 9999,
        opacity: 0,
        pointerEvents: 'all',
        coversViewport: true
      },
      {
        tag: 'div',
        id: 'click-through',
        className: 'safe-layer',
        zIndex: 10,
        opacity: 0,
        pointerEvents: 'none',
        coversViewport: true
      }
    ],
    viewport: { activePlugin: 'rcp-fe-lol-loot' }
  };

  const result = parseDomHierarchy(rawData);
  // Only the blocking one (pointer-events: all) should be flagged, not pointer-events: none
  assert.equal(result.invisibleBackdrops.length, 1);
  assert.equal(result.invisibleBackdrops[0].id, 'stuck-backdrop');
  assert.equal(result.invisibleBackdrops[0].zIndex, 9999);
  assert.equal(result.invisibleBackdrops[0].opacity, 0);
  assert.equal(result.invisibleBackdrops[0].pointerEvents, 'all');
  assert.equal(result.invisibleBackdrops[0].blocking, true);
  assert.match(result.summary, /WARNING: 1 invisible backdrop/);
});

test('parseDomHierarchy identifies viewport route and active plugin', () => {
  const rawData = {
    modals: [],
    overlays: [],
    viewport: {
      activePlugin: 'rcp-fe-lol-champ-select',
      currentScreen: 'rcp-fe-lol-champ-select',
      routeName: 'champ-select/pick',
      documentTitle: 'Champion Select',
      location: 'https://127.0.0.1:2999/index.html#champ-select/pick'
    }
  };

  const result = parseDomHierarchy(rawData);
  assert.equal(result.viewport.activePlugin, 'rcp-fe-lol-champ-select');
  assert.equal(result.viewport.currentScreen, 'rcp-fe-lol-champ-select');
  assert.equal(result.viewport.routeName, 'champ-select/pick');
  assert.equal(result.viewport.documentTitle, 'Champion Select');
  assert.equal(result.viewport.location, 'https://127.0.0.1:2999/index.html#champ-select/pick');
});

test('parseDomHierarchy extracts focused element details', () => {
  const rawData = {
    focusedElement: {
      tag: 'input',
      id: 'search-champions',
      className: 'search-input',
      placeholder: 'Search Champion...',
      text: ''
    }
  };

  const result = parseDomHierarchy(rawData);
  assert.deepEqual(result.focusedElement, {
    tag: 'input',
    id: 'search-champions',
    className: 'search-input',
    placeholder: 'Search Champion...',
    text: ''
  });
});

test('parseDomHierarchy ignores focused body or null', () => {
  const result1 = parseDomHierarchy({ focusedElement: { tag: 'body' } });
  assert.equal(result1.focusedElement, null);

  const result2 = parseDomHierarchy({ focusedElement: null });
  assert.equal(result2.focusedElement, null);
});

test('parseDomHierarchy respects includeOverlaysOnly and maxDepth options', () => {
  const rawData = {
    modals: [{ tag: 'dialog', zIndex: 10, visible: true }],
    overlays: [],
    hierarchy: {
      tag: 'div',
      id: 'root',
      visible: true,
      children: [
        {
          tag: 'div',
          id: 'child-1',
          visible: true,
          children: [
            {
              tag: 'div',
              id: 'child-2',
              visible: true,
              children: [
                { tag: 'span', id: 'leaf', visible: true }
              ]
            }
          ]
        }
      ]
    }
  };

  const overlaysOnly = parseDomHierarchy(rawData, { includeOverlaysOnly: true });
  assert.equal(overlaysOnly.hierarchy, null);
  assert.equal(overlaysOnly.activeModals.length, 1);

  const depthLimited = parseDomHierarchy(rawData, { includeOverlaysOnly: false, maxDepth: 2 });
  assert.ok(depthLimited.hierarchy);
  assert.equal(depthLimited.hierarchy.children.length, 1);
  assert.equal(depthLimited.hierarchy.children[0].children, undefined);
});

test('inspectDomTree evaluates CDP expression and parses results', async () => {
  const mockCdp = {
    evaluate: async (expr) => {
      assert.ok(expr.includes('rcp-fe-lol-'));
      return {
        value: {
          modals: [{ tag: 'lol-uikit-dialog-frame', zIndex: 100, visible: true, buttons: [] }],
          overlays: [],
          viewport: { activePlugin: 'rcp-fe-lol-loot' },
          focusedElement: null,
          hierarchy: null
        },
        exceptionDetails: null
      };
    }
  };

  const result = await inspectDomTree(mockCdp, { includeOverlaysOnly: true });
  assert.equal(result.activeModals.length, 1);
  assert.equal(result.viewport.activePlugin, 'rcp-fe-lol-loot');
});

test('inspectDomTree throws error if CDP evaluate returns exceptionDetails', async () => {
  const mockCdp = {
    evaluate: async () => ({
      value: null,
      exceptionDetails: { description: 'ReferenceError: document is not defined' }
    })
  };

  await assert.rejects(
    () => inspectDomTree(mockCdp),
    /CDP DOM inspection failed: ReferenceError: document is not defined/
  );
});

test('lol_cdp_dom_tree MCP tool runs inspection and returns expected shape', async () => {
  const ctx = fakeContext();
  ctx.cdp.evaluate = async () => ({
    value: {
      modals: [
        {
          tag: 'lol-uikit-dialog-frame',
          id: 'prompt',
          className: 'modal',
          title: 'Ready Check',
          zIndex: 500,
          visible: true,
          buttons: [{ tag: 'button', text: 'Accept', disabled: false }]
        }
      ],
      overlays: [],
      viewport: {
        activePlugin: 'rcp-fe-lol-matchmaking',
        currentScreen: 'matchmaking',
        routeName: 'matchmaking'
      },
      focusedElement: null,
      hierarchy: null
    },
    exceptionDetails: null
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_dom_tree',
    arguments: { includeOverlaysOnly: true }
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.activeModals.length, 1);
  assert.equal(payload.activeModals[0].title, 'Ready Check');
  assert.equal(payload.viewport.activePlugin, 'rcp-fe-lol-matchmaking');
  assert.match(payload.summary, /Active modals: 1/);
});

test('lol_cdp_dom_tree declares annotations [true, false, true, true]', async () => {
  const { client } = await connect(fakeContext());
  const tools = await client.listTools();
  const tool = tools.tools.find((t) => t.name === 'lol_cdp_dom_tree');
  assert.ok(tool, 'Tool lol_cdp_dom_tree should be registered');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  });
});
