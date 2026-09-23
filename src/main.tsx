import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './estilos.css'

const raiz = document.getElementById('root')
if (raiz === null) throw new Error('#root não existe no index.html.')

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
