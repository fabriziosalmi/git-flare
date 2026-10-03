declare module '*.wasm' {
  const value: WebAssembly.Module;
  export default value;
}

declare module '*.woff2' {
  const value: ArrayBuffer;
  export default value;
}
