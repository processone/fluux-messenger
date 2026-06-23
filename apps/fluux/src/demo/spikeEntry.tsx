import { createRoot } from 'react-dom/client'
import { VirtualizationSpike } from './virtualizationSpike'

const root = document.getElementById('root')
if (root) createRoot(root).render(<VirtualizationSpike />)
