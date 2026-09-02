import '@fontsource-variable/fraunces';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { HostProvider, hostAdapter } from './host';
import { I18nProvider } from './i18n';
import { ConnectionProvider } from './state/connection';
import { startThemeSync } from './lib/theme';
import './index.css';

// Before the first render: the palette must be right on the first frame, or a
// dark-theme user gets a paper-white flash on every launch.
startThemeSync(hostAdapter);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false },
  },
});

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HostProvider>
        <I18nProvider>
          <ConnectionProvider>
            <BrowserRouter>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </BrowserRouter>
          </ConnectionProvider>
        </I18nProvider>
      </HostProvider>
    </QueryClientProvider>
  </StrictMode>,
);
