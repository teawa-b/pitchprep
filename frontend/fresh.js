// A tab left open across a deploy keeps running the old code. When the tab comes back into view and the server
// is on a newer version, reload it; if something is open or running, say so instead of throwing it away.
export function keepFresh(busy = () => false, tell = () => {}) {
  let mine = null, told = false;
  const check = async () => {
    try {
      const { version } = await fetch('/api/health', { cache: 'no-store' }).then(r => r.json());
      if (!mine) { mine = version; return; }
      if (!version || version === mine) return;
      if (!busy()) location.reload();
      else if (!told) { told = true; tell('This app was just updated. Reload the page to get the latest version.', 9000); }
    } catch {}
  };
  check();
  addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}
