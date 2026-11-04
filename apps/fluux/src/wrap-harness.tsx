import React from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import { CollapsibleContent } from '@/components/conversation/CollapsibleContent'
import { renderStyledMessage } from '@/utils/messageStyles'
import { messageOccurrenceKey } from '@/components/conversation/messageRowIdentity'

const email = [
  "Hi Gia, hi Thai,", "",
  "I'm Adrien from ProcessOne, following up on Jérôme's email. We'd be glad to have processes reviewed together with the whole ejabberd team.", "",
  "A few questions to get started:",
  "1. What are the next steps to check whether ejabberd is eligible? Is there anything you need from us before the eligibility review begins?",
  "2. What scope do you usually cover? Besides the main repository (https://github.com/processone/ejabberd) are there other repositories that should be included?",
  "3. How would findings be reported? We already handle security reports through GitHub security advisories and a dedicated mailbox.", "", "Best regards,",
].join('\n')
const tall = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${'lorem ipsum dolor sit amet consectetur '.repeat(6)}`).join('\n')
const msgs = [
  { id: 'm1', conversationId: 'a@x', body: 'Je pense répondre comme ça :\n```\n' + email + '\n```' },
  { id: 'm2', conversationId: 'a@x', body: 'Taller block:\n```\n' + tall + '\n```' },
]
const w = new URLSearchParams(location.search).get('w') ?? '700'
let rowClicks = 0
function App() {
  const [n, setN] = React.useState(0)
  return <div style={{ width: Number(w), margin: 16 }} className="bg-fluux-chat text-fluux-text">
    <div id="row-clicks" onClick={() => { rowClicks++; setN(rowClicks) }}>row clicks: {n}</div>
    {msgs.map(m => <div key={m.id} data-m={m.id} onClick={() => { rowClicks++; setN(rowClicks) }}>
      <CollapsibleContent messageId={m.id} wrapKey={messageOccurrenceKey(m as never)}>
        <div className="break-words whitespace-pre-wrap">{renderStyledMessage(m.body, undefined, undefined, undefined, true, undefined, messageOccurrenceKey(m as never))}</div>
      </CollapsibleContent></div>)}
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)
