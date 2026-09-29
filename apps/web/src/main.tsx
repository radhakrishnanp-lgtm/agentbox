import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { applyTheme, loadTheme } from './lib/theme.ts';
import { AuthProvider } from './state/auth.tsx';

applyTheme(loadTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
      <Toaster position="top-center" theme="system" richColors closeButton />
    </ErrorBoundary>
  </StrictMode>,
);
