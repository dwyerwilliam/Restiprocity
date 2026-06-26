import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../renderer/styles/globals.css';

if (import.meta.env.DEV) {
  window.addEventListener('error', (event) => {
    console.error('[Dev Error]', {
      type: 'runtime-error',
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error?.stack,
      timestamp: new Date().toISOString(),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Dev Error]', {
      type: 'unhandled-rejection',
      reason: event.reason,
      promise: event.promise,
      timestamp: new Date().toISOString(),
    });
    event.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
