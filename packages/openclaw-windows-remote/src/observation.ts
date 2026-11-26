export type Point = { x: number; y: number };
type Frame = {
  width: number; height: number;
  screenWidth: number; screenHeight: number;
  origin: Point;
};

function snapshotMetadata(text: string): string {
  return text.split(/^\s*Active Desktop:/mu, 1)[0];
}

function reportedDisplays(metadata: string) {
  const displays = /^Visible Displays: ([^\r\n]+)$/mu.exec(metadata)?.[1];
  if (!displays) return [];
  return Array.from(displays.matchAll(/(?:^|; )(\d+):[^;]+ \((-?\d+(?:,-?\d+){3})\)( primary)?(?=; |$)/gu),
    (match) => ({ index: Number(match[1]), bounds: match[2], primary: Boolean(match[3]) }));
}

export function visibleDisplays(text: string): Array<{ index: number; primary: boolean }> {
  return reportedDisplays(snapshotMetadata(text)).map(({ index, primary }) => ({ index, primary }));
}

export function matchesCapturedDisplay(text: string, index: number): boolean {
  const metadata = snapshotMetadata(text);
  const selected = /^Selected Displays: (\d+)[ \t]*$/mu.exec(metadata)?.[1];
  const region = /^Screenshot Region: \((-?\d+(?:,-?\d+){3})\)[ \t]*$/mu.exec(metadata)?.[1];
  return selected === String(index) && region !== undefined &&
    reportedDisplays(metadata).some((display) => display.index === index && display.bounds === region);
}

export function readFrame(text: string, png: string): Frame | undefined {
  const header = Buffer.from(png.slice(0, 44), "base64");
  if (header.length < 24 || header.toString("ascii", 12, 16) !== "IHDR") return;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const metadata = snapshotMetadata(text);
  const size = /^\s*Screenshot (?:Original )?Size: \((\d+),(\d+)\)\s*$/mu.exec(metadata);
  const region = /^\s*Screenshot Region: \((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)\s*$/mu.exec(metadata);
  const origin = /^\s*Screenshot Origin: \((-?\d+),(-?\d+)\)/mu.exec(metadata) ??
    /^\s*Screenshot Coordinate Scale: [\d.]+ .*?then add \((-?\d+),(-?\d+)\), the screen coordinate/mu.exec(metadata);
  if (!width || !height || !size) return;
  const [screenWidth, screenHeight] = size.slice(1).map(Number);
  if (screenWidth < width || screenHeight < height || screenWidth > 65535 || screenHeight > 65535) return;
  if (region && (Number(region[3]) - Number(region[1]) !== screenWidth ||
                 Number(region[4]) - Number(region[2]) !== screenHeight)) return;
  return {
    width, height, screenWidth, screenHeight,
    origin: { x: Number(region?.[1] ?? origin?.[1] ?? 0), y: Number(region?.[2] ?? origin?.[2] ?? 0) },
  };
}

export function screenPoint(frame: Frame, pixel: Point): Point | undefined {
  if (pixel.x < 0 || pixel.x >= frame.width || pixel.y < 0 || pixel.y >= frame.height) return;
  return {
    x: frame.origin.x + Math.floor((pixel.x + 0.5) * frame.screenWidth / frame.width),
    y: frame.origin.y + Math.floor((pixel.y + 0.5) * frame.screenHeight / frame.height),
  };
}

export function imagePoint(frame: Frame, point: Point): Point | undefined {
  const x = point.x - frame.origin.x;
  const y = point.y - frame.origin.y;
  if (x < 0 || x >= frame.screenWidth || y < 0 || y >= frame.screenHeight) return;
  return { x: Math.floor(x * frame.width / frame.screenWidth), y: Math.floor(y * frame.height / frame.screenHeight) };
}

export function elementsIn(text: string) {
  const trees = [...text.matchAll(/^[ \t]*UI Tree:[ \t]*\r?\n[ \t]*desktop[ \t]*(?:\r?\n|$)/gmu)];
  const tree = trees.at(-1);
  const lines = tree ? text.slice(tree.index + tree[0].length).split(/\r?\n[ \t]*\r?\n/u, 1)[0] : "";
  return new Map(Array.from(lines.matchAll(/^[ \t│]*[├└]── \[#(\d{1,5})\][ \t]*\((-?\d+),[ \t]*(-?\d+)\)[ \t]*([^\r\n]*)/gmu), (match) => [
    Number(match[1]), { x: Number(match[2]), y: Number(match[3]), description: match[4] },
  ]));
}

export function focusedWindow(text: string): string | undefined {
  const window = /^\s*Focused Window:\s*\n([\s\S]*?)\n\s*Opened Windows:/mu.exec(text)?.[1].trim();
  return window && window !== "No active window found" ? window : undefined;
}

export function matchesObservedElement(
  current: string,
  window: string | undefined,
  element: number,
  expected: Point & { description: string },
): boolean {
  if (!window || focusedWindow(current) !== window) return false;
  const entry = elementsIn(current.slice(0, 32000)).get(element);
  return entry?.x === expected.x && entry.y === expected.y && entry.description === expected.description;
}
