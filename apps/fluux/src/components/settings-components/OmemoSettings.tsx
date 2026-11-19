import { OmemoDevicesSection } from './OmemoDevicesSection'

/** Settings > Encryption > OMEMO. Today the account's device list; the 0.20 OMEMO controls build on this screen. */
export function OmemoSettings() {
  return (
    <section className="w-full max-w-md">
      <OmemoDevicesSection />
    </section>
  )
}
