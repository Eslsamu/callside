import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import LocalTest from './LocalTest';
import { loadTemplate } from './template';
import './styles.css';
async function render() {
  const initial = window.location.pathname === '/local-test' ? null : await loadTemplate();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {initial ? (
        <App initialSettings={initial.settings} initialError={initial.error} />
      ) : (
        <LocalTest />
      )}
    </React.StrictMode>,
  );
}
void render();
