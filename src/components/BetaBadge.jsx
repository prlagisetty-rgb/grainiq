// Small amber "BETA" chip shown next to the GrainIQ logo while the product is
// in beta. Mirrors the dark-theme badge styling (cf. the teal "Pro" chip).
export default function BetaBadge({ className = '' }) {
  return (
    <span
      className={`rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wider text-amber-400 ring-1 ring-inset ring-amber-400/30 ${className}`}
    >
      Beta
    </span>
  )
}
