import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Boxwire from './products/boxwire/Boxwire.jsx'
import './fonts.css'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Boxwire />
  </StrictMode>,
)
