declare module 'bs58' {
  export function encode(buffer: Buffer | Uint8Array): string;
  export function decode(str: string): Buffer;
}
