import { StoreProvider, useStore } from './state/store';
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
  return (
    <>
      <TitleBar />
      <div className="app" data-platform={window.aim?.platform ?? 'win32'}>
        <Sidebar />
        <main className="main">
          <Main />
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
