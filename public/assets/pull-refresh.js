// Tirer pour actualiser (téléphones tactiles, Android en tête).
const MAX = 120;
export const THRESHOLD = 70;

// Le geste ne démarre qu'en haut de page, sans fenêtre ouverte ni liste intérieure déjà défilée.
export function canStartPull({ scrollY, modalOpen, innerScrolled }) {
  return scrollY <= 0 && !modalOpen && !innerScrolled;
}

// Le doigt relâché au-delà du seuil actualise ; en deçà, rien ne se passe.
export function shouldRefresh(dist) {
  return dist >= THRESHOLD;
}

// Distance affichée pour un glissement du doigt de `dy` px : freinée, jamais négative, plafonnée.
export function pullDistance(dy) {
  if (dy <= 0) return 0;
  return Math.min(MAX, dy * 0.5);
}

const OPEN = '.modal-bg:not(.hidden), .drawer:not(.hidden), #zoom:not(.hidden)';
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
const SPINNER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';
const CSS = `
  .ptr { position: fixed; top: 0; left: 50%; z-index: 100; width: 40px; height: 40px; margin: -48px 0 0 -20px; border-radius: 50%;
    display: grid; place-items: center; background: #15130f; border: 1px solid rgba(212, 173, 90, .35); color: #d4ad5a;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .45); pointer-events: none; opacity: 0; }
  .ptr svg { width: 20px; height: 20px; transition: transform .2s; }
  .ptr.ready svg { transform: rotate(180deg); }
  .ptr.back { transition: transform .25s cubic-bezier(.2, .8, .2, 1), opacity .25s; }
  .ptr.busy svg { animation: ptr-spin .8s linear infinite; }
  @keyframes ptr-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .ptr.busy svg { animation: none; } }`;

// Branche le geste sur la page : une pastille or descend avec le doigt, la flèche se retourne
// quand on a tiré assez loin, et lâcher à ce moment-là recharge l'app.
export function mount(doc, win) {
  // Notre geste remplace celui du navigateur (sinon Chrome actualiserait deux fois).
  doc.documentElement.style.overscrollBehaviorY = 'contain';

  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);

  const ind = doc.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = ARROW;
  doc.body.append(ind);

  let startY = null, dist = 0, busy = false;
  const paint = (d) => {
    ind.style.transform = `translateY(${d ? d + 12 : 0}px)`;
    ind.style.opacity = Math.min(1, d / THRESHOLD);
    ind.classList.toggle('ready', shouldRefresh(d));
  };

  win.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1) return;
    const ok = canStartPull({ scrollY: win.scrollY, modalOpen: !!doc.querySelector(OPEN), innerScrolled: insideScrolled(e.target, doc.body) });
    startY = ok ? e.touches[0].clientY : null;
    dist = 0;
    ind.classList.remove('back');
  }, { passive: true });

  win.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dist = pullDistance(e.touches[0].clientY - startY);
    if (dist > 0 && e.cancelable) e.preventDefault(); // la page ne rebondit pas pendant qu'on tire
    paint(dist);
  }, { passive: false });

  const end = () => {
    if (startY === null) return;
    startY = null;
    ind.classList.add('back');
    if (!shouldRefresh(dist)) return paint(0);
    busy = true;
    ind.classList.add('busy');
    ind.innerHTML = SPINNER;
    paint(THRESHOLD - 10);
    win.location.reload();
  };
  win.addEventListener('touchend', end);
  win.addEventListener('touchcancel', end);
}

// Sur écran tactile seulement : rien à faire sur ordinateur.
export function autoMount(doc, win, nav) {
  const touch = 'ontouchstart' in win || nav.maxTouchPoints > 0;
  if (!touch) return false;
  if (doc.body) mount(doc, win);
  else win.addEventListener('DOMContentLoaded', () => mount(doc, win));
  return true;
}

if (typeof document !== 'undefined') autoMount(document, window, navigator);

// Le doigt est-il posé dans une zone qui défile elle-même et n'est pas revenue en haut ?
export function insideScrolled(el, root) {
  for (; el && el !== root; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
}
