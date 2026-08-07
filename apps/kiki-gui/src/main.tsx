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

import { App } from './App';
import { ConnectionProvider } from './state/connection';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false },
  },
});

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
