import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';

const utf8Decoder = new TextDecoder('utf-8');

function toUint8Array(value: Uint8Array | ArrayLike<number>): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value);
}

function classifyWireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid field|illegal tag.*field no 0/i.test(message)) {
    return new Error('Unsupported AGY native metadata field', { cause: error });
  }
  if (/invalid varint/i.test(message)) {
    return new Error('Unsupported AGY native metadata encoding', { cause: error });
  }
  if (error instanceof RangeError || /premature eof|beyond end|out of range|eof/i.test(message)) {
    return new Error('Truncated AGY native metadata', { cause: error });
  }
  return new Error('Unsupported AGY native metadata encoding', { cause: error });
}

export function nativeBytesAt(
  value: Uint8Array | ArrayLike<number>,
  path: readonly number[],
  optionalLast?: false,
  repeatedLast?: false,
): string;
export function nativeBytesAt(
  value: Uint8Array | ArrayLike<number>,
  path: readonly number[],
  optionalLast: boolean,
  repeatedLast?: false,
): string | undefined;
export function nativeBytesAt(
  value: Uint8Array | ArrayLike<number>,
  path: readonly number[],
  optionalLast: boolean,
  repeatedLast: true,
): string[];
export function nativeBytesAt(
  value: Uint8Array | ArrayLike<number>,
  path: readonly number[],
  optionalLast = false,
  repeatedLast = false,
): string | string[] | undefined {
  let bytes = toUint8Array(value);
  for (const [index, field] of path.entries()) {
    const reader = new BinaryReader(bytes);
    let selected: Uint8Array | undefined;
    const repeated: string[] = [];
    const last = index === path.length - 1;

    while (reader.pos < reader.len) {
      let fieldNo: number;
      let wireType: WireType;
      try {
        [fieldNo, wireType] = reader.tag();
      } catch (error) {
        throw classifyWireError(error);
      }
      if (!fieldNo) {
        throw new Error('Unsupported AGY native metadata field');
      }

      if (wireType === WireType.Varint || wireType === WireType.Bit64 || wireType === WireType.Bit32) {
        try {
          reader.skip(wireType);
        } catch (error) {
          throw classifyWireError(error);
        }
      } else if (wireType === WireType.LengthDelimited) {
        let slice: Uint8Array;
        try {
          slice = reader.bytes();
        } catch (error) {
          throw classifyWireError(error);
        }
        if (fieldNo === field) {
          if (repeatedLast && last) {
            repeated.push(utf8Decoder.decode(slice));
          } else if (selected !== undefined) {
            throw new Error('Ambiguous AGY native metadata binding');
          } else {
            selected = slice;
          }
        }
      } else {
        throw new Error('Unsupported AGY native metadata wire type');
      }
    }

    if (repeatedLast && last) {
      if (repeated.length === 0 && !optionalLast) {
        throw new Error('Unconfirmed AGY native metadata binding');
      }
      return repeated;
    }
    if (selected === undefined) {
      if (optionalLast) return repeatedLast ? [] : undefined;
      throw new Error('Unconfirmed AGY native metadata binding');
    }
    bytes = selected;
  }
  return utf8Decoder.decode(bytes);
}

export function nativeStringsAt(
  value: Uint8Array | ArrayLike<number>,
  path: readonly number[],
  optionalLast = false,
): string[] {
  return nativeBytesAt(value, path, optionalLast, true);
}

export type NativeProtoField =
  | { readonly fieldNo: number; readonly kind: 'string'; readonly value: string }
  | { readonly fieldNo: number; readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly fieldNo: number; readonly kind: 'varint'; readonly value: number }
  | { readonly fieldNo: number; readonly kind: 'fixed32'; readonly value: number }
  | { readonly fieldNo: number; readonly kind: 'fixed64'; readonly value: bigint }
  | { readonly fieldNo: number; readonly kind: 'message'; readonly fields: readonly NativeProtoField[] };

export function encodeNativeMessage(fields: readonly NativeProtoField[]): Uint8Array {
  const writer = new BinaryWriter();
  for (const field of fields) {
    switch (field.kind) {
      case 'string':
        writer.tag(field.fieldNo, WireType.LengthDelimited).string(field.value);
        break;
      case 'bytes':
        writer.tag(field.fieldNo, WireType.LengthDelimited).bytes(field.value);
        break;
      case 'varint':
        writer.tag(field.fieldNo, WireType.Varint).uint32(field.value);
        break;
      case 'fixed32':
        writer.tag(field.fieldNo, WireType.Bit32).fixed32(field.value);
        break;
      case 'fixed64':
        writer.tag(field.fieldNo, WireType.Bit64).fixed64(field.value);
        break;
      case 'message':
        writer.tag(field.fieldNo, WireType.LengthDelimited).bytes(encodeNativeMessage(field.fields));
        break;
    }
  }
  return writer.finish();
}
