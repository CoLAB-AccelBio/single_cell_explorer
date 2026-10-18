export function rasterDimensions(width: number, height: number, scale = 1) {
  return { width: width * scale, height: height * scale };
}
export function embeddedRasterSvg(width: number, height: number, dataUrl: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Raster plot (embedded PNG, not vector)</title><image width="${width}" height="${height}" href="${dataUrl}"/></svg>`;
}