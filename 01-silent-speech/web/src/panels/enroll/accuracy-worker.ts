// Worker entry: runs ml.evaluate off the main thread (see accuracy.ts).
// Lives in a subfolder on purpose: main.ts auto loads ./panels/*.ts, and this must not run on the page.
import { runEval, type EvalRequest, type EvalResponse } from './eval-core';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage(m: EvalResponse): void;
};
scope.onmessage = (e) => scope.postMessage(runEval(e.data));
