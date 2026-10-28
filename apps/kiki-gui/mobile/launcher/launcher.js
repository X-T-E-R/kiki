// Unbundled browser module: the extension is part of the URL.
// oxlint-disable-next-line import/extensions
import { displayOrigin, readTarget } from './target.js';

/*
 * The shell's first screen. It remembers one server origin (never a link or a
 * token) and hands navigation to the native KikiShell plugin, which keeps that
 * origin inside the app and sends every other site to the system browser.
 * The app reopens straight into the remembered server; this screen returns
 * only when that server cannot be reached or the person asks to change it.
 */

const STORE_KEY = 'kiki.shell.origin';
const STARTED_KEY = 'kiki.shell.started';

const COPY = {
  en: {
    lede: 'Connect to Kiki on your computer.',
    label: 'Server address or entry link',
    hint: 'Settings → Web access on that computer shows the address and a one-time link.',
    open: 'Open Kiki',
    opening: 'Opening…',
    recent: 'Last server',
    empty: 'Enter the address shown in Web access.',
    invalid: 'That is not a server address. Try something like 192.168.1.5:5494.',
    scheme: 'Only http and https addresses can be opened.',
    credentials: 'Leave the user name and password out of the address.',
    unreachable: 'Could not reach {host}. Check that Kiki is running and this phone is on the same network.',
  },
  zh: {
    lede: '打开你电脑上的 Kiki。',
    label: '服务器地址或访问链接',
    hint: '在那台电脑的 设置 → Web 访问 里可以看到地址和一次性链接。',
    open: '打开 Kiki',
    opening: '正在打开…',
    recent: '上次的服务器',
    empty: '请输入 Web 访问里显示的地址。',
    invalid: '这不像服务器地址，可以试试 192.168.1.5:5494 这样的格式。',
    scheme: '只能打开 http 或 https 地址。',
    credentials: '地址里不要带用户名和密码。',
    unreachable: '连不上 {host}。请确认 Kiki 正在运行，且手机和电脑在同一网络。',
  },
};

const lang = /^zh\b/i.test(navigator.language) ? 'zh' : 'en';
const copy = COPY[lang];
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = copy[node.dataset.i18n];

const form = document.querySelector('#connect');
const input = document.querySelector('#server');
const button = document.querySelector('#open');
const problem = document.querySelector('#problem');
const recent = document.querySelector('#recent');
const recentOpen = document.querySelector('#recent-open');
const recentHost = document.querySelector('#recent-host');

function savedOrigin() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function showProblem(text) {
  problem.textContent = text;
  problem.hidden = text === '';
  input.ariaInvalid = text === '' ? 'false' : 'true';
}

async function open(origin, entry) {
  try {
    localStorage.setItem(STORE_KEY, origin);
  } catch { /* storage unavailable: the server still opens for this run */ }
  button.disabled = true;
  button.textContent = copy.opening;
  const shell = window.Capacitor;
  if (shell?.isNativePlatform?.() === true) {
    try {
      await shell.nativePromise('KikiShell', 'open', { origin, entry });
      return;
    } catch {
      /* fall through to a plain navigation */
    }
  }
  window.location.assign(entry);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = readTarget(input.value);
  if (!target.ok) {
    showProblem(copy[target.reason]);
    input.focus();
    return;
  }
  showProblem('');
  void open(target.origin, target.entry);
});

input.addEventListener('input', () => { if (!problem.hidden) showProblem(''); });

const origin = savedOrigin();
const reason = window.location.hash.replace(/^#/, '');
if (origin !== null) {
  recentHost.textContent = displayOrigin(origin);
  recent.hidden = false;
  recentOpen.addEventListener('click', () => { void open(origin, `${origin}/`); });
}

let firstVisit = false;
try {
  firstVisit = sessionStorage.getItem(STARTED_KEY) === null;
  sessionStorage.setItem(STARTED_KEY, '1');
} catch { /* no session storage: always show the screen */ }

// `#change` (the launcher shortcut) and `#unreachable` (the shell's error
// page) both stay here; only a clean cold start reopens the saved server.
// The error page can arrive as a same-document hash change (the launcher was
// already showing), so it is read again on every change, not just on load.
function showUnreachable() {
  const attempted = savedOrigin();
  button.disabled = false;
  button.textContent = copy.open;
  if (attempted === null) return;
  const host = displayOrigin(attempted).replace(' · http', '');
  input.value = host;
  showProblem(copy.unreachable.replace('{host}', host));
}

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#unreachable') showUnreachable();
});

if (reason === 'unreachable') {
  showUnreachable();
} else if (origin !== null && firstVisit && reason === '') {
  void open(origin, `${origin}/`);
}
