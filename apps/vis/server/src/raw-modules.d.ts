// Raw-string imports for prompt sources reachable through the v2 engine's
// types. Vite/Vitest handles `?raw` natively; tsdown uses the shared
// `raw-text-plugin` for the same import shape.

declare module '*?raw' {
  const content: string;
  export default content;
}
