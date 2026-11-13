import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary, reportError } from './components/ErrorBoundary';
import './styles/index.css';

// Safe mode (?safe=1): the main process reloads with this after a failed start. Saved interface state —
// last chat, view, panel states — may be what breaks start-up, so begin from a clean slate.
if (new URLSearchParams(window.location.search).has('safe')) {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('aim.')) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
  // Done; a later reload in this session should not wipe the state again.
  window.history.replaceState(null, '', window.location.pathname);
}

window.addEventListener('error', (e) => {
  reportError(`uncaught ${e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : e.message} (${e.filename ?? ''}:${e.lineno ?? 0})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as unknown;
  reportError(`unhandled rejection: ${r instanceof Error ? `${r.name}: ${r.message}` : String(r)}`);
});

async function boot() {
  if (!window.aim) {
    // Plain-browser preview: install the in-memory mock API.
    const { installMockAim } = await import('./mock/mockAim');
    installMockAim();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary scope="app">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void boot();
