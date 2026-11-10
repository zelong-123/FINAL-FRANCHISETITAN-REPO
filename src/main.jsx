import React from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { startLiveSync } from './lib/liveSync.js';
import { PORTAL_TITLE } from './lib/portal.js';

startLiveSync();
if (PORTAL_TITLE) document.title = PORTAL_TITLE;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </React.StrictMode>,
);
