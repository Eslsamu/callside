import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import LocalTest from './LocalTest';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname === '/local-test' ? <LocalTest /> : <App />}
  </React.StrictMode>,
);
