import { useEffect } from 'react';
import { StoreProvider, useStore } from './state/store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { GoalsView } from './components/GoalsView';
import { MemoryView } from './components/MemoryView';
import { SettingsView } from './components/SettingsView';
import { Toasts } from './components/Toasts';

function Main() {
  const { state } = useStore();
  switch (state.view) {
    case 'goals':
      return <GoalsView />;
    case 'memory':
      return <MemoryView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <ChatView />;
  }
}

function Shell() {
  const { state } = useStore();
  useEffect(() => {
    // First successful render: tell the main process the window is alive (startup watchdog).
    const id = requestAnimationFrame(() => window.aim?.rendererReady?.());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <>
      <TitleBar />
      <div className="app" data-platform={window.aim?.platform ?? 'win32'}>
        <Sidebar />
        <main className="main">
          <ErrorBoundary scope="view" resetKey={`${state.view}:${state.currentChatId ?? ''}`}>
            <Main />
          </ErrorBoundary>
        </main>
      </div>
      <Toasts />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
