// Worker entry: builds the demo model off the main thread (see demo-build.ts).
// Lives in a subfolder on purpose: main.ts auto loads ./panels/*.ts, and this must not run on the page.
import type { ClassDef } from '../../core/contracts';
import { buildDemoJSON, type DemoResponse } from './demo-model';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ classes: ClassDef[] }>) => void) | null;
  postMessage(m: DemoResponse): void;
};
scope.onmessage = (e) => scope.postMessage(buildDemoJSON(e.data.classes));
