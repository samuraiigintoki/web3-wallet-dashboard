/**
 * Minimal PNG reader, so the walks can sample the pixels where a focus ring
 * should be painted instead of trusting a rectangle. Test infrastructure.
 */
import { inflateSync } from 'node:zlib'

export type Png = {
  width: number
  height: number
  at: (x: number, y: number) => [number, number, number] | null
}

export function decodePng(buffer: Buffer): Png {
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a png')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const data: Buffer[] = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8] ?? 0
      colorType = body[9] ?? 0
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported png: depth ${bitDepth} colour type ${colorType}`)
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(data))
  const pixels = Buffer.alloc(height * stride)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const current = Buffer.from(line)

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] ?? 0 : 0
      const b = previous[x] ?? 0
      const c = x >= channels ? previous[x - channels] ?? 0 : 0

      switch (filter) {
        case 0:
          break
        case 1:
          current[x] = ((current[x] ?? 0) + a) & 0xff
          break
        case 2:
          current[x] = ((current[x] ?? 0) + b) & 0xff
          break
        case 3:
          current[x] = ((current[x] ?? 0) + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          current[x] =
            ((current[x] ?? 0) + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default:
          throw new Error(`unknown png filter ${filter}`)
      }
    }

    current.copy(pixels, y * stride)
    previous = current
  }

  return {
    width,
    height,
    at(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return null
      }
      const index = y * stride + x * channels
      return [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0]
    },
  }
}
