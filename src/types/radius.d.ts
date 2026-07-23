declare module 'radius' {
  interface DecodeArgs {
    packet: Buffer;
    secret: string;
  }
  interface EncodeResponseArgs {
    packet: unknown;
    code: string;
    secret: string;
    attributes?: Array<[string, string | number]>;
  }
  interface DecodeResult {
    code: string;
    identifier: number;
    length: number;
    attributes: Record<string, unknown>;
    raw_attributes?: unknown[];
  }
  export function decode(args: DecodeArgs): DecodeResult;
  export function encode_response(args: EncodeResponseArgs): Buffer;
  export function encode(args: Record<string, unknown>): Buffer;
}
