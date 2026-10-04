import "./seal.css";

// The Seal look: every name printed in vermilion seal paste on warm paper, the way a Japanese hanko
// stamps. A filled container (Block and Mark's square) becomes the red block with the letters carved
// out; every other name prints as red letters. It is a way of looking at the grid, like White on
// black, not part of a recipe: exports stay black on white.

/**
 * The worn print every wordmark is drawn through while Seal is on (seal.css). Mounted once; each
 * wordmark's SVG points at it. Three things a real stamp does, each from its own noise:
 * - rough edges: every edge is pushed about a pixel either way, as a carved stone prints;
 * - uneven ink: broad soft patches where the paste went down thinner;
 * - specks: small spots where the paste missed the paper.
 * The knocked-out letters are drawn in the paper colour, so thinning them changes nothing you can see.
 */
export function SealFilter() {
  return (
    <svg className="seal-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="seal-wear" x="-4%" y="-4%" width="108%" height="108%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves={2} seed={4} result="grain" />
        <feDisplacementMap in="SourceGraphic" in2="grain" scale={2.4} xChannelSelector="R" yChannelSelector="G" result="rough" />
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves={3} seed={9} result="patches" />
        {/* Alpha 1.35 − 0.7 × noise: full ink over most of the print, down to about 80% in the thin patches. */}
        <feColorMatrix in="patches" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.7 0 0 0 1.35" result="thin" />
        <feTurbulence type="fractalNoise" baseFrequency="0.45" numOctaves={1} seed={2} result="grit" />
        {/* Alpha 25.4 − 33 × noise: solid below 0.74, gone above 0.77, so only the noise's highest peaks become specks. */}
        <feColorMatrix in="grit" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -33 0 0 0 25.4" result="specks" />
        <feComposite in="thin" in2="specks" operator="in" result="ink" />
        <feComposite in="rough" in2="ink" operator="in" />
      </filter>
    </svg>
  );
}
