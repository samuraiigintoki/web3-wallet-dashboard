import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Declarations first, then the application. The layer order statement in
// tokens.css has to be evaluated before any stylesheet that writes into a
// layer, and the module stylesheets arrive with App.
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/base.css'
import App from './App.tsx'

const container = document.getElementById('root')
if (!container) {
  throw new Error('root element is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
