function LogomarkPaths() {
  return <>
    <g fill="none" stroke="#336699" strokeLinecap="round" strokeWidth={4}>
      <line x1="30" y1="16" x2="34" y2="16"/>
      <line x1="16" y1="30" x2="16" y2="34"/>
      <line x1="30" y1="48" x2="34" y2="48"/>
      <line x1="26" y1="38" x2="38" y2="26"/>
    </g>

    <g fill="#6699cc" stroke="#336699" strokeWidth={4}>
      <circle cx="16" cy="16" r="8"/>
      <circle cx="48" cy="16" r="8"/>
      <circle cx="16" cy="48" r="8"/>
      <circle cx="48" cy="48" r="8"/>
    </g>
  </>
}

export function Logomark(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" fill="none" {...props}>
      <LogomarkPaths/>
    </svg>
  )
}

export function Logo(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 340 64" fill="none" {...props}>
      <LogomarkPaths/>
      <text x="75" y="44" fontSizeAdjust="1.3" fontWeight="700" letterSpacing="2px"
            fontFamily="'lexend', 'lexend Fallback'">STATEFLOW</text>
    </svg>
  )
}
