import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import WindowsCheck from './WindowsCheck';
import LocalTest from './LocalTest';
import ComparisonTest from './ComparisonTest';
import { loadTemplates } from './template';
import './styles.css';
async function render() {
  const windowsCheck = window.location.pathname === '/windows-check';
  const comparison = window.location.pathname === '/local-compare';
  const initial =
    windowsCheck || comparison || window.location.pathname === '/local-test'
      ? null
      : await loadTemplates();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {windowsCheck ? (
        <WindowsCheck />
      ) : comparison ? (
        <ComparisonTest />
      ) : initial ? (
        <App
          initialLibrary={initial.library}
          initialSettings={initial.settings}
          initialError={initial.error}
        />
      ) : (
        <LocalTest />
      )}
    </React.StrictMode>,
  );
}
void render();
