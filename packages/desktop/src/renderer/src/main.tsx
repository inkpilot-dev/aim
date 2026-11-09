import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

async function boot() {
  if (!window.aim) {
    // Plain-browser preview: install the in-memory mock API.
    const { installMockAim } = await import('./mock/mockAim');
    installMockAim();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
