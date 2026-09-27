import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SpaApp } from './SpaApp';
import './i18n';
import './globals.css';

const container = document.querySelector('#root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <SpaApp />
    </BrowserRouter>
  </StrictMode>,
);
