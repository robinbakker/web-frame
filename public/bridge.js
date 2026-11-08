// The Frame This window of the desktop app (bridge.html). window.webFrame comes from
// src/electron/bridge-preload.ts; served by the admin UI instead, the page stays empty.
const api = window.webFrame;
const $ = (id) => document.getElementById(id);

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function tvItem(tv) {
  const item = document.createElement('li');
  let detail;
  if (tv.lastError) detail = tv.lastError;
  else if (!tv.reachable) detail = 'Offline';
  else if (tv.artMode === false) detail = 'Not in Art Mode';
  else detail = tv.lastUploadAt ? `In Art Mode · updated ${time(tv.lastUploadAt)}` : 'In Art Mode';
  item.className = tv.lastError ? 'tv-error' : tv.reachable && tv.artMode ? 'tv-ok' : '';

  const name = document.createElement('span');
  name.className = 'tv-name';
  name.textContent = tv.name || tv.model || 'TV';
  const ip = document.createElement('span');
  ip.className = 'tv-ip';
  ip.textContent = tv.tvIp;
  const text = document.createElement('span');
  text.className = 'tv-detail';
  text.textContent = detail;
  item.append(name, ip, text);
  return item;
}

function render(state) {
  const connected = state.view === 'status';
  $('connect').hidden = connected;
  $('status').hidden = !connected;
  $('version').textContent = `Web Frame ${state.version}`;

  if (!connected) {
    const relink = state.linkProblem !== null;
    $('connect-title').textContent = relink ? 'Link this bridge again' : 'Connect to Frame This';
    if (relink) {
      $('connect-intro').textContent =
        (state.linkProblem === 'unlinked'
          ? "Frame This no longer accepts this computer's connect code: a new code was made, or the bridge was removed. "
          : "The saved connect code isn't valid. ") +
        'In Frame This, open TVs, choose Bridge settings for this bridge, then New connect code (or add a bridge), and paste the code here.';
    }
    $('standalone').hidden = state.mode !== 'setup';
    $('restart-note').hidden = state.mode !== 'standalone';
    return;
  }

  $('status-line').textContent = state.paused ? 'Paused' : state.status;
  $('warning').hidden = !state.warning;
  $('warning').textContent = state.warning ?? '';
  $('tvs').replaceChildren(...state.tvs.map(tvItem));
  $('tvs').hidden = state.tvs.length === 0;
  $('no-tvs').hidden = state.tvs.length > 0;
  $('notice').hidden = !state.notice;
  $('notice').textContent = state.notice ?? '';
}

if (api) {
  api.getState().then(render);
  api.onState(render);

  $('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('connect-button');
    const code = $('code').value.trim();
    $('connect-error').textContent = '';
    if (!code) {
      $('connect-error').textContent = 'Paste the connect code first.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      const result = await api.connect(code);
      if (result?.error) $('connect-error').textContent = result.error;
      else $('code').value = '';
    } catch {
      $('connect-error').textContent = 'Something went wrong. Try again.';
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });

  $('standalone').addEventListener('click', async () => {
    const button = $('standalone');
    button.disabled = true;
    try {
      await api.useStandalone();
    } finally {
      button.disabled = false;
    }
  });
  $('open').addEventListener('click', () => api.openFrameThis());
  $('unlink').addEventListener('click', () => api.unlink());
  $('run-now').addEventListener('click', async () => {
    const button = $('run-now');
    button.disabled = true;
    try {
      await api.runNow();
    } finally {
      button.disabled = false;
    }
  });
}
