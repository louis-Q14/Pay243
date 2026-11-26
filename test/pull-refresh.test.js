import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ptr from '../public/assets/pull-refresh.js';
import { pullDistance, shouldRefresh, canStartPull, THRESHOLD } from '../public/assets/pull-refresh.js';

// Une page minimale : juste ce que mount() touche.
function fakePage({ modalOpen = false } = {}) {
  const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {}, innerHTML: '' });
  const handlers = {};
  const page = {
    reloads: 0,
    doc: {
      documentElement: { style: {} }, head: el(), body: el(),
      createElement: el,
      querySelector: () => (modalOpen ? {} : null),
    },
    win: {
      scrollY: 0,
      addEventListener: (name, fn) => { handlers[name] = fn; },
      location: { reload: () => { page.reloads++; } },
    },
    drag(fromY, toY) {
      const target = { parentElement: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      handlers.touchstart({ touches: [{ clientY: fromY }], target });
      handlers.touchmove({ touches: [{ clientY: toY }], target, cancelable: true, preventDefault() {} });
      handlers.touchend({});
    },
  };
  return page;
}

test('pull-refresh.js mount : tirer vers le bas en haut de page actualise l’app', () => {
  assert.equal(typeof ptr.mount, 'function', 'pull-refresh.js doit exporter mount');
  const p = fakePage();
  ptr.mount(p.doc, p.win);
  assert.equal(p.doc.documentElement.style.overscrollBehaviorY, 'contain', 'mount doit couper le geste natif du navigateur (pas de double actualisation)');
  p.drag(100, 130);
  assert.equal(p.reloads, 0, 'mount : un petit glissement ne doit pas actualiser');
  p.drag(100, 400);
  assert.equal(p.reloads, 1, 'mount : tirer assez loin puis lâcher doit actualiser');

  const m = fakePage({ modalOpen: true });
  ptr.mount(m.doc, m.win);
  m.drag(100, 400);
  assert.equal(m.reloads, 0, 'mount : pas d’actualisation quand une fenêtre est ouverte');
});

test('pull-refresh.js autoMount : actif sur écran tactile, absent sur ordinateur', () => {
  assert.equal(typeof ptr.autoMount, 'function', 'pull-refresh.js doit exporter autoMount');
  const desk = fakePage();
  assert.equal(ptr.autoMount(desk.doc, desk.win, { maxTouchPoints: 0 }), false, 'autoMount ne doit rien brancher sur ordinateur');
  assert.equal(desk.doc.documentElement.style.overscrollBehaviorY, undefined, 'autoMount sur ordinateur ne doit pas toucher la page');
  const phone = fakePage();
  assert.equal(ptr.autoMount(phone.doc, phone.win, { maxTouchPoints: 5 }), true, 'autoMount doit se brancher sur téléphone');
  phone.drag(100, 400);
  assert.equal(phone.reloads, 1, 'autoMount : sur téléphone, tirer vers le bas doit actualiser');
});

test('pull-refresh.js insideScrolled : repère une liste intérieure déjà défilée', () => {
  assert.equal(typeof ptr.insideScrolled, 'function', 'pull-refresh.js doit exporter insideScrolled');
  const body = { parentElement: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  const list = { parentElement: body, scrollTop: 40, scrollHeight: 900, clientHeight: 300 };
  const row = { parentElement: list, scrollTop: 0, scrollHeight: 20, clientHeight: 20 };
  assert.equal(ptr.insideScrolled(row, body), true, 'insideScrolled doit voir la liste défilée au-dessus du doigt');
  list.scrollTop = 0;
  assert.equal(ptr.insideScrolled(row, body), false, 'insideScrolled liste revenue en haut doit répondre non');
});

test('pull-refresh.js canStartPull : seulement en haut de page, sans fenêtre ouverte', () => {
  assert.equal(typeof canStartPull, 'function', 'pull-refresh.js doit exporter canStartPull');
  assert.equal(canStartPull({ scrollY: 0, modalOpen: false, innerScrolled: false }), true, 'canStartPull en haut de page doit autoriser');
  assert.equal(canStartPull({ scrollY: 30, modalOpen: false, innerScrolled: false }), false, 'canStartPull page défilée doit refuser');
  assert.equal(canStartPull({ scrollY: 0, modalOpen: true, innerScrolled: false }), false, 'canStartPull avec une fenêtre ouverte doit refuser');
  assert.equal(canStartPull({ scrollY: 0, modalOpen: false, innerScrolled: true }), false, 'canStartPull dans une liste défilée doit refuser');
});

test('pull-refresh.js shouldRefresh : actualise seulement au-delà du seuil', () => {
  assert.equal(typeof shouldRefresh, 'function', 'pull-refresh.js doit exporter shouldRefresh');
  assert.equal(shouldRefresh(THRESHOLD - 1), false, 'shouldRefresh sous le seuil ne doit pas actualiser');
  assert.equal(shouldRefresh(THRESHOLD), true, 'shouldRefresh au seuil doit actualiser');
});

test('pull-refresh.js pullDistance : résistance, rien vers le haut, plafonné', () => {
  assert.equal(pullDistance(-40), 0, 'pullDistance doit ignorer un glissement vers le haut');
  assert.ok(pullDistance(100) < 100, 'pullDistance doit freiner le doigt (résistance)');
  assert.ok(pullDistance(100) > 0, 'pullDistance doit suivre le doigt');
  assert.ok(pullDistance(2000) <= 120, 'pullDistance doit être plafonné à 120 px');
});
